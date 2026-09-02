import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { getKpiResourceDir } from "../../../config.ts";
import { type JsonSchema, validateJsonSchema } from "../graph/json-schema.ts";
import { isJsonObject } from "../graph/schema.ts";
import { atomicWrite } from "../run-store.ts";
import { ROLE_CONTRACT_FILE, type WorkerRole } from "./roles.ts";

/**
 * The capability NH-03 records: one agent, one job, one role, one declared path.
 *
 * The tuple is minted when the worker starts and is not an argument at call
 * time, so a worker cannot widen its own pin by asking differently.
 *
 * `capabilityId` is the bearer half: the parent minted it, only this worker was
 * given it, and a receipt carrying it is therefore this worker's. It is kept out
 * of every log, event and tool result.
 */
export interface ContractPin {
	agentId: string;
	jobId: string;
	role: WorkerRole;
	capabilityId: string;
	/** The absolute path this capability may write, and nothing else. */
	absolutePath: string;
	/** Repository-relative form, for messages. */
	declaredPath: string;
	schema: string;
	/** Where this capability's publication receipt lives. */
	receiptPath: string;
}

export class ContractWriteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContractWriteError";
	}
}

/**
 * A durable receipt for one publication.
 *
 * It lives beside the worker's session rather than inside the contract, because
 * `verdict.schema.json` and `evidence.schema.json` describe a reviewer's and a
 * tester's findings - not the harness's delivery bookkeeping. Adding fields to
 * them to carry this would change two published contracts to record something
 * neither is about.
 *
 * The receipt is what makes a publication attributable: a contract file that
 * appeared by some other route has no receipt, and a receipt whose hash does not
 * match the bytes on disk describes a different publication than the one there.
 */
export interface PublicationReceipt {
	/** Fresh per publication, so identical content republished is still new. */
	publication_id: string;
	capability_id: string;
	agent_id: string;
	job_id: string;
	role: WorkerRole;
	declared_path: string;
	content_sha256: string;
	published_at: string;
}

export function receiptPathFor(runDirectory: string, agentId: string): string {
	return join(runDirectory, "agents", `${agentId}.receipt.json`);
}

/**
 * Mints the pin for a role that publishes through `write_contract`. Roles that
 * hold a mutation tool get none: they are the writer already.
 */
export function mintContractPin(options: {
	agentId: string;
	jobId: string;
	role: WorkerRole;
	runDirectory: string;
	capabilityId: string;
}): ContractPin | undefined {
	const declared = ROLE_CONTRACT_FILE[options.role];
	if (declared === undefined) {
		return undefined;
	}
	return {
		agentId: options.agentId,
		jobId: options.jobId,
		role: options.role,
		capabilityId: options.capabilityId,
		absolutePath: resolve(options.runDirectory, declared.file),
		declaredPath: declared.file,
		schema: declared.schema,
		receiptPath: receiptPathFor(options.runDirectory, options.agentId),
	};
}

async function loadSchema(name: string): Promise<JsonSchema> {
	return JSON.parse(await readFile(join(getKpiResourceDir(), "schemas", name), "utf8")) as JsonSchema;
}

export function hashContractBytes(bytes: string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Whether a requested path is the pinned one.
 *
 * Compared after resolution, so `..`, a different job's run directory, another
 * role's contract, and a symlink whose target is elsewhere are all the same
 * refusal. The parent directory is resolved rather than the file itself, because
 * the file legitimately may not exist yet.
 */
async function resolvesToPin(requested: string, pin: ContractPin): Promise<boolean> {
	const absolute = isAbsolute(requested) ? resolve(requested) : resolve(dirname(pin.absolutePath), requested);
	const [realParent, realPinParent] = await Promise.all([
		realpath(dirname(absolute)).catch(() => undefined),
		realpath(dirname(pin.absolutePath)).catch(() => undefined),
	]);
	if (realParent === undefined || realPinParent === undefined || realParent !== realPinParent) {
		// A different directory - another job's run, a traversal, a linked parent -
		// is not the pinned path. An unresolvable directory is refused rather than
		// written to.
		return false;
	}
	if (basename(absolute) !== basename(pin.absolutePath)) {
		return false;
	}
	// A link standing where the contract belongs must not publish somewhere else.
	// Compared against the pinned location itself, not against the link's own
	// target, which would agree with itself.
	const realFile = await realpath(absolute).catch(() => undefined);
	if (realFile !== undefined && realFile !== join(realPinParent, basename(pin.absolutePath))) {
		return false;
	}
	return true;
}

/**
 * Publishes a role's run contract, then its receipt.
 *
 * The order matters twice. Identity, then path, then schema, then disk: an
 * invalid payload writes nothing at all - no partial file, no placeholder -
 * because a reviewer that cannot produce a valid verdict has failed review
 * rather than approved anything. And contract bytes before receipt: a crash in
 * between leaves a contract with no receipt, which the parent refuses. Failing
 * closed there is the point.
 */
export async function writeContract(options: {
	pin: ContractPin | undefined;
	agentId: string;
	jobId: string;
	role: WorkerRole;
	requestedPath: string;
	payload: unknown;
	now?: () => Date;
	newPublicationId?: () => string;
	loadSchemaImpl?: (name: string) => Promise<JsonSchema>;
}): Promise<{ path: string; receipt: PublicationReceipt }> {
	const { pin } = options;
	if (pin === undefined) {
		throw new ContractWriteError(`role ${options.role} has no pinned contract capability`);
	}
	if (pin.agentId !== options.agentId || pin.jobId !== options.jobId || pin.role !== options.role) {
		throw new ContractWriteError(
			`contract capability is pinned to ${pin.role} ${pin.agentId} in job ${pin.jobId}, not ${options.role} ${options.agentId} in job ${options.jobId}`,
		);
	}
	if (typeof options.requestedPath !== "string" || options.requestedPath.trim().length === 0) {
		throw new ContractWriteError("write_contract requires a path");
	}
	if (!(await resolvesToPin(options.requestedPath, pin))) {
		throw new ContractWriteError(
			`write_contract may only write ${pin.declaredPath} for ${pin.role}; refused ${options.requestedPath}`,
		);
	}
	if (typeof options.payload !== "object" || options.payload === null || Array.isArray(options.payload)) {
		throw new ContractWriteError("write_contract takes the parsed contract object, not a diff or prose");
	}

	const schema = await (options.loadSchemaImpl ?? loadSchema)(pin.schema);
	const errors = validateJsonSchema(options.payload, schema);
	if (errors.length > 0) {
		throw new ContractWriteError(`${pin.declaredPath} does not satisfy ${pin.schema}: ${errors.join("; ")}`);
	}

	const bytes = `${JSON.stringify(options.payload, null, 2)}\n`;
	const receipt: PublicationReceipt = {
		publication_id: (options.newPublicationId ?? randomUUID)(),
		capability_id: pin.capabilityId,
		agent_id: pin.agentId,
		job_id: pin.jobId,
		role: pin.role,
		declared_path: pin.declaredPath,
		content_sha256: hashContractBytes(bytes),
		published_at: (options.now ?? (() => new Date()))().toISOString(),
	};

	await atomicWrite(pin.absolutePath, bytes);
	await atomicWrite(pin.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
	return { path: pin.declaredPath, receipt };
}

/** Reads a receipt, or `undefined` when there is none or it is not one. */
export async function readPublicationReceipt(path: string): Promise<PublicationReceipt | undefined> {
	const source = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	});
	if (source === undefined) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		return undefined;
	}
	if (!isJsonObject(parsed)) {
		return undefined;
	}
	const fields = [
		"publication_id",
		"capability_id",
		"agent_id",
		"job_id",
		"role",
		"declared_path",
		"content_sha256",
		"published_at",
	] as const;
	for (const field of fields) {
		if (typeof parsed[field] !== "string" || (parsed[field] as string).length === 0) {
			return undefined;
		}
	}
	return parsed as unknown as PublicationReceipt;
}

export type PublicationRejection =
	| { kind: "no-receipt" }
	| { kind: "stale-receipt"; publicationId: string }
	| { kind: "wrong-capability" }
	| { kind: "wrong-path"; declaredPath: string }
	| { kind: "missing-contract" }
	| { kind: "hash-mismatch" }
	| { kind: "malformed-contract" }
	| { kind: "invalid-contract"; errors: string[] };

export type PublicationOutcome =
	| { kind: "accepted"; receipt: PublicationReceipt; document: Record<string, unknown> }
	| { kind: "rejected"; rejection: PublicationRejection };

export function describeRejection(rejection: PublicationRejection): string {
	switch (rejection.kind) {
		case "no-receipt":
			return "no publication receipt: the contract file was not published through write_contract";
		case "stale-receipt":
			return `receipt ${rejection.publicationId} is the one that was already there before this delivery`;
		case "wrong-capability":
			return "receipt was issued to a different agent or capability";
		case "wrong-path":
			return `receipt declares ${rejection.declaredPath}, not this role's contract`;
		case "missing-contract":
			return "receipt exists but the contract file does not";
		case "hash-mismatch":
			return "receipt hash does not match the contract bytes on disk";
		case "malformed-contract":
			return "contract file is not parseable JSON";
		case "invalid-contract":
			return `contract does not satisfy its schema: ${rejection.errors.join("; ")}`;
	}
}

/**
 * Decides whether a role's contract has been freshly, authoritatively published.
 *
 * Every clause is a way a publication can be fake or stale: no receipt at all (a
 * direct filesystem write), a receipt from before this delivery, someone else's
 * receipt, a receipt for another path, a receipt whose hash disagrees with the
 * bytes, or bytes that do not satisfy the schema. Only the last step reads the
 * contract as an answer.
 */
export async function evaluatePublication(options: {
	pin: Pick<ContractPin, "agentId" | "capabilityId" | "declaredPath" | "absolutePath" | "receiptPath" | "schema">;
	baselinePublicationId?: string;
	loadSchemaImpl?: (name: string) => Promise<JsonSchema>;
}): Promise<PublicationOutcome> {
	const { pin } = options;
	const receipt = await readPublicationReceipt(pin.receiptPath);
	if (receipt === undefined) {
		return { kind: "rejected", rejection: { kind: "no-receipt" } };
	}
	if (receipt.publication_id === options.baselinePublicationId) {
		return { kind: "rejected", rejection: { kind: "stale-receipt", publicationId: receipt.publication_id } };
	}
	if (receipt.agent_id !== pin.agentId || receipt.capability_id !== pin.capabilityId) {
		return { kind: "rejected", rejection: { kind: "wrong-capability" } };
	}
	if (receipt.declared_path !== pin.declaredPath) {
		return { kind: "rejected", rejection: { kind: "wrong-path", declaredPath: receipt.declared_path } };
	}

	const bytes = await readFile(pin.absolutePath, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	});
	if (bytes === undefined) {
		return { kind: "rejected", rejection: { kind: "missing-contract" } };
	}
	if (hashContractBytes(bytes) !== receipt.content_sha256) {
		return { kind: "rejected", rejection: { kind: "hash-mismatch" } };
	}

	let document: unknown;
	try {
		document = JSON.parse(bytes);
	} catch {
		return { kind: "rejected", rejection: { kind: "malformed-contract" } };
	}
	if (!isJsonObject(document)) {
		return { kind: "rejected", rejection: { kind: "malformed-contract" } };
	}
	const schema = await (options.loadSchemaImpl ?? loadSchema)(pin.schema);
	const errors = validateJsonSchema(document, schema);
	if (errors.length > 0) {
		return { kind: "rejected", rejection: { kind: "invalid-contract", errors } };
	}
	return { kind: "accepted", receipt, document: document as Record<string, unknown> };
}
