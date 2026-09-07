import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type EngineeringModelIdentity = string | { provider: string; id: string };
export const engineeringModelSlug = (model: EngineeringModelIdentity): string =>
	typeof model === "string" ? model : `${model.provider}/${model.id}`;
export const DEFAULT_OBSERVATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Host observations only. Omitted metrics are unknown, never zero or a model's self-assessment. */
export interface EngineeringObserved {
	taskSuccess?: boolean;
	verification?: "passed" | "failed";
	reviewerDefects?: number;
	toolFailures?: number;
	toolCalls?: number;
	latencyMs?: number;
	contextTokens?: number;
}

export interface EngineeringOutcomeInput extends EngineeringObserved {
	projectRoot: string;
	role: string;
	model: EngineeringModelIdentity;
	taskId: string;
	/** A comparable task category; omission is its own category, not a wildcard. */
	taskKind?: string;
	/** Existing local raw evidence file, absolute or relative to projectRoot. */
	evidenceRef: string;
	source: "host-verification" | "local-evaluation" | "review-verification";
	observedAt?: string;
}

export interface EngineeringOutcome extends EngineeringObserved {
	version: 1;
	id: string;
	role: string;
	model: string;
	taskId: string;
	taskKind?: string;
	evidenceRef: string;
	evidenceSha256: string;
	source: EngineeringOutcomeInput["source"];
	observedAt: string;
}

/** Operator-authored priors, not measurements or fabricated catalog rankings. */
export interface EngineeringPrior {
	role: string;
	model: string;
	taskKind?: string;
	quality: "preferred" | "adequate" | "avoid";
	rationale: string;
	expiresAt?: string;
}

export const engineeringRegistryDirectory = (projectRoot: string): string =>
	join(projectRoot, ".kpi", "kstack", "engineering");
const digest = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const modelIdentity = (value: unknown): value is string => nonempty(value) && /^[^/\s]+\/.+$/u.test(value);
const date = (value: unknown): value is string => nonempty(value) && Number.isFinite(Date.parse(value));

function validMetrics(value: EngineeringObserved): boolean {
	if (value.taskSuccess !== undefined && typeof value.taskSuccess !== "boolean") return false;
	if (value.verification !== undefined && value.verification !== "passed" && value.verification !== "failed")
		return false;
	for (const key of ["reviewerDefects", "toolFailures", "toolCalls", "contextTokens"] as const) {
		if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key]! < 0)) return false;
	}
	if (value.latencyMs !== undefined && (!Number.isFinite(value.latencyMs) || value.latencyMs < 0)) return false;
	return value.toolFailures === undefined || value.toolCalls === undefined || value.toolFailures <= value.toolCalls;
}

function validOutcome(value: EngineeringOutcome): boolean {
	return (
		value !== null &&
		typeof value === "object" &&
		value.version === 1 &&
		nonempty(value.id) &&
		nonempty(value.role) &&
		modelIdentity(value.model) &&
		nonempty(value.taskId) &&
		(value.taskKind === undefined || nonempty(value.taskKind)) &&
		nonempty(value.evidenceRef) &&
		/^[a-f0-9]{64}$/u.test(value.evidenceSha256) &&
		date(value.observedAt) &&
		["host-verification", "local-evaluation", "review-verification"].includes(value.source) &&
		validMetrics(value)
	);
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
	await rename(temporary, path);
}

export async function recordEngineeringOutcome(input: EngineeringOutcomeInput): Promise<EngineeringOutcome> {
	const { projectRoot, model, evidenceRef, ...fields } = input;
	const outcome: EngineeringOutcome = {
		...fields,
		version: 1,
		id: randomUUID(),
		model: engineeringModelSlug(model),
		observedAt: input.observedAt ?? new Date().toISOString(),
		evidenceRef: resolve(projectRoot, evidenceRef),
		evidenceSha256: "0".repeat(64),
	};
	if (!validOutcome(outcome))
		throw new Error(
			"Invalid engineering outcome: identity, host source, timestamp and observed metrics are required to be well formed",
		);
	outcome.evidenceSha256 = digest(await readFile(outcome.evidenceRef));
	const directory = join(engineeringRegistryDirectory(projectRoot), "outcomes");
	await mkdir(directory, { recursive: true });
	await writeAtomic(join(directory, `${outcome.id}.json`), outcome);
	return outcome;
}

export async function configureEngineeringPriors(projectRoot: string, priors: EngineeringPrior[]): Promise<void> {
	if (!priors.every(validPrior))
		throw new Error("Invalid engineering prior; use exact model identities and an operator rationale");
	await mkdir(engineeringRegistryDirectory(projectRoot), { recursive: true });
	await writeAtomic(join(engineeringRegistryDirectory(projectRoot), "priors.json"), { version: 1, priors });
}

function validPrior(value: EngineeringPrior): boolean {
	return (
		value !== null &&
		typeof value === "object" &&
		nonempty(value.role) &&
		modelIdentity(value.model) &&
		nonempty(value.rationale) &&
		["preferred", "adequate", "avoid"].includes(value.quality) &&
		(value.taskKind === undefined || nonempty(value.taskKind)) &&
		(value.expiresAt === undefined || date(value.expiresAt))
	);
}

export interface EngineeringCapability {
	model: string;
	role: string;
	taskKind?: string;
	outcomes: EngineeringOutcome[];
	prior?: EngineeringPrior;
}

/** Read afresh on dispatch: no process-local learned state, stale/mutated/missing evidence cannot confer quality. */
export async function readEngineeringCapabilities(request: {
	projectRoot: string;
	role: string;
	taskKind?: string;
	models: string[];
	now?: number;
	maxAgeMs?: number;
}): Promise<EngineeringCapability[]> {
	const now = request.now ?? Date.now();
	const maxAge = request.maxAgeMs ?? DEFAULT_OBSERVATION_MAX_AGE_MS;
	if (!Number.isFinite(maxAge) || maxAge < 0 || !Number.isFinite(now))
		throw new Error("Invalid engineering observation freshness window");
	const directory = engineeringRegistryDirectory(request.projectRoot);
	const capabilities = new Map(
		request.models.map((model) => [
			model,
			{ model, role: request.role, taskKind: request.taskKind, outcomes: [] } as EngineeringCapability,
		]),
	);
	const files = await readdir(join(directory, "outcomes")).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const latest = new Map<string, EngineeringOutcome>();
	for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
		let outcome: EngineeringOutcome;
		try {
			outcome = JSON.parse(await readFile(join(directory, "outcomes", file), "utf8"));
		} catch {
			continue;
		}
		if (
			!validOutcome(outcome) ||
			outcome.role !== request.role ||
			outcome.taskKind !== request.taskKind ||
			!capabilities.has(outcome.model)
		)
			continue;
		const age = now - Date.parse(outcome.observedAt);
		if (age < 0 || age > maxAge) continue;
		try {
			if (digest(await readFile(resolve(request.projectRoot, outcome.evidenceRef))) !== outcome.evidenceSha256)
				continue;
		} catch {
			continue;
		}
		// Repeated recording of the same task is not an independent extra success sample.
		const key = JSON.stringify([outcome.model, outcome.taskId]);
		const previous = latest.get(key);
		if (!previous || Date.parse(outcome.observedAt) > Date.parse(previous.observedAt)) latest.set(key, outcome);
	}
	for (const outcome of latest.values()) capabilities.get(outcome.model)!.outcomes.push(outcome);
	try {
		const document = JSON.parse(await readFile(join(directory, "priors.json"), "utf8"));
		if (document !== null && typeof document === "object" && document.version === 1 && Array.isArray(document.priors))
			for (const prior of document.priors) {
				if (
					validPrior(prior) &&
					prior.role === request.role &&
					prior.taskKind === request.taskKind &&
					(!prior.expiresAt || Date.parse(prior.expiresAt) > now)
				) {
					const capability = capabilities.get(prior.model);
					if (capability) capability.prior = prior;
				}
			}
	} catch (error) {
		if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return [...capabilities.values()];
}

/** Lexicographic evidence, not a synthetic precision score. Latency/cost cannot defeat quality. */
export function compareEngineeringCapabilities(left: EngineeringCapability, right: EngineeringCapability): number {
	const balance = (capability: EngineeringCapability, key: "verification" | "taskSuccess"): number => {
		const observed = capability.outcomes.filter((outcome) => outcome[key] !== undefined);
		return observed.length
			? observed.reduce((sum, outcome) => sum + (outcome[key] === true || outcome[key] === "passed" ? 1 : -1), 0) /
					observed.length
			: 0;
	};
	const defects = (capability: EngineeringCapability, key: "reviewerDefects" | "toolFailures"): number => {
		const observed = capability.outcomes.filter((outcome) => outcome[key] !== undefined);
		return observed.length ? observed.reduce((sum, outcome) => sum + outcome[key]!, 0) / observed.length : 0;
	};
	for (const key of ["verification", "taskSuccess"] as const) {
		const difference = balance(right, key) - balance(left, key);
		if (difference) return difference;
	}
	for (const key of ["reviewerDefects", "toolFailures"] as const) {
		const difference = defects(left, key) - defects(right, key);
		if (difference) return difference;
	}
	const prior = (value: EngineeringCapability): number =>
		value.prior?.quality === "preferred" ? 1 : value.prior?.quality === "avoid" ? -1 : 0;
	return prior(right) - prior(left);
}

export function engineeringCapabilityReasons(capability: EngineeringCapability): string[] {
	const { outcomes } = capability;
	const reasons = [
		`${capability.model}: ${outcomes.length} applicable evidence-backed task outcome(s); missing metrics remain unknown.`,
	];
	for (const key of [
		"verification",
		"taskSuccess",
		"reviewerDefects",
		"toolFailures",
		"toolCalls",
		"latencyMs",
		"contextTokens",
	] as const) {
		const measured = outcomes.filter((outcome) => outcome[key] !== undefined);
		if (measured.length)
			reasons.push(`${key}: ${measured.map((outcome) => `${outcome[key]} [${outcome.evidenceRef}]`).join(", ")}`);
	}
	if (capability.prior)
		reasons.push(`Operator prior ${capability.prior.quality} (not a measurement): ${capability.prior.rationale}`);
	return reasons;
}
