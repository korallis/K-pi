import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { isLocalPool, poolIdForProvider } from "../extensions/accounts/store.ts";
import { modelFamily } from "./ladder.ts";
import { INHERIT_PARENT, type KStackModels, readKStackModels } from "./models.ts";
import {
	compareEngineeringCapabilities,
	engineeringCapabilityReasons,
	readEngineeringCapabilities,
} from "./observations.ts";

export { recordEngineeringOutcome } from "./observations.ts";

export interface EngineeringModelRequest {
	role: string;
	modelRuntime: Pick<ModelRuntime, "getAvailable">;
	parentModel: Model<Api>;
	builderModel?: Model<Api>;
	policyPath?: string;
	projectRoot?: string;
	taskKind?: string;
	requiredContextTokens?: number;
	observationMaxAgeMs?: number;
}

export interface EngineeringModelResolution {
	model: Model<Api>;
	reason: string[];
	family: string | undefined;
}

const ROLE_POLICY: Record<string, string> = { builder: "implementer", reviewer: "judgment", planner: "precise" };
const slug = (model: Model<Api>): string => `${model.provider}/${model.id}`;

export function engineeringRoleMapping(policy: KStackModels | undefined, role: string): string[] {
	const reviewer = role === "reviewer" || role === "review_panel" || role === "judgment";
	const entry =
		policy?.roles[role] ??
		policy?.roles[ROLE_POLICY[role] ?? role] ??
		(reviewer ? policy?.roles.review_panel : undefined);
	return (Array.isArray(entry) ? entry : entry ? [entry] : []).filter((value) => value !== INHERIT_PARENT);
}

/** Model quality policy is separate from the request-time account slot scheduler. */
export async function resolveEngineeringModel(request: EngineeringModelRequest): Promise<EngineeringModelResolution> {
	const [available, policy] = await Promise.all([
		request.modelRuntime.getAvailable(),
		readKStackModels(request.policyPath),
	]);
	const reason = ["Catalog/auth availability is not a task-quality measurement. Account scheduling remains separate."];
	const reviewer = request.role === "reviewer" || request.role === "review_panel" || request.role === "judgment";
	const configured = engineeringRoleMapping(policy, request.role);
	const explicit = new Set([...configured, ...(policy?.fallback_models ?? [])]);
	const parentSlug = slug(request.parentModel);
	const parentLocal = isLocalPool(poolIdForProvider(request.parentModel.provider) ?? request.parentModel.provider);
	if (
		request.requiredContextTokens !== undefined &&
		(!Number.isSafeInteger(request.requiredContextTokens) || request.requiredContextTokens < 0)
	)
		throw new Error("Invalid required context token count");
	const eligible = available.filter((model) => {
		const local = isLocalPool(poolIdForProvider(model.provider) ?? model.provider);
		if (local !== parentLocal && !explicit.has(slug(model))) {
			reason.push(`${slug(model)} excluded by local/cloud authorization boundary.`);
			return false;
		}
		if (
			request.requiredContextTokens !== undefined &&
			(!Number.isFinite(model.contextWindow) || model.contextWindow < request.requiredContextTokens)
		) {
			reason.push(
				`${slug(model)} excluded: context capacity ${model.contextWindow || "unknown"} cannot meet ${request.requiredContextTokens} required tokens.`,
			);
			return false;
		}
		return true;
	});
	const live = new Map(eligible.map((model) => [slug(model), model]));
	const ordered: Model<Api>[] = [];
	const add = (name: string): void => {
		const model = live.get(name);
		if (model && !ordered.includes(model)) ordered.push(model);
	};
	for (const name of configured) {
		if (!live.has(name)) reason.push(`Configured candidate ${name} is unavailable or unauthenticated; skipped.`);
		add(name);
	}
	add(parentSlug);
	for (const name of policy?.fallback_models ?? []) add(name);
	for (const model of eligible) add(slug(model));
	if (!ordered.length) throw new Error(`No available authenticated model for engineering role ${request.role}`);
	const familyOf = (model: Model<Api>): string | undefined =>
		policy?.model_families?.[slug(model)] ?? modelFamily(slug(model));
	const builderFamily = familyOf(request.builderModel ?? request.parentModel);
	const capabilities = request.projectRoot
		? await readEngineeringCapabilities({
				projectRoot: request.projectRoot,
				role: request.role,
				taskKind: request.taskKind,
				models: ordered.map(slug),
				maxAgeMs: request.observationMaxAgeMs,
			})
		: [];
	const byModel = new Map(capabilities.map((capability) => [capability.model, capability]));
	const mapped = ordered.filter((candidate) => configured.includes(slug(candidate)));
	// An explicit mapping is an operator constraint; independence and observations cannot escape it.
	let candidates = mapped.length ? mapped : ordered;
	if (reviewer && builderFamily) {
		const independent = candidates.filter((candidate) => {
			const family = familyOf(candidate);
			return family !== undefined && family !== builderFamily;
		});
		if (independent.length) {
			candidates = independent;
			reason.push(
				`Reviewer prefers a different identified model family from builder ${builderFamily}, within operator constraints.`,
			);
		} else
			reason.push(
				"No independently identified family available within operator constraints; single-family review remains operational, without claiming independent-model review.",
			);
	} else if (reviewer) reason.push("Builder family is unknown; review independence cannot be established.");
	if (!mapped.length && capabilities.length)
		candidates = [...candidates].sort((left, right) =>
			compareEngineeringCapabilities(byModel.get(slug(left))!, byModel.get(slug(right))!),
		);
	const model = candidates[0];
	for (const capability of capabilities) reason.push(...engineeringCapabilityReasons(capability));
	if (!capabilities.some((capability) => capability.outcomes.length))
		reason.push("Measured quality is unknown: no fresh applicable intact evidence.");
	reason.push(
		"Quality comparison precedes affinity; latency and cost are reported only, never used to outrank quality.",
	);
	if (configured.includes(slug(model))) reason.push(`Selected explicit operator role mapping for ${request.role}.`);
	else if (slug(model) === parentSlug)
		reason.push("Preserved parent model affinity among quality-compatible candidates.");
	else if (policy?.fallback_models?.includes(slug(model)))
		reason.push("Selected an available operator-ordered fallback.");
	else
		reason.push(
			"Selected an eligible candidate using applicable host evidence and operator priors when present; otherwise native availability order.",
		);
	const family = familyOf(model);
	if (!family) reason.push("Selected model family is unknown; provider identity is not model-family identity.");
	return { model, reason, family };
}
