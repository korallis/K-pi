import { Type } from "@earendil-works/pi-ai";

import { defineTool, type ExtensionAPI, type ExtensionContext } from "../../core/extensions/types.ts";
import { kModeState } from "../kstack/mode.ts";
import { hasWorkerDescriptor } from "./bus/identity.ts";
import { isLiveJob, readActiveJob } from "./run-store.ts";
import { resolveRoutingMode } from "./settings.ts";

export const START_JOB_TOOL = "kpi_start_job";

/** Shorter than this is a word, a greeting, or a reply - not an engineering goal. */
export const MIN_GOAL_LENGTH = 12;

export type JobMode = "gated" | "autopilot";

export interface PendingDispatch {
	goal: string;
	mode: JobMode;
	reason: string;
	/** The `/kpi` command line the loop will be started with. */
	text: string;
}

/**
 * Process-local: the job the agent asked for during the current turn. Drained on
 * `agent_end`. Exported so tests can observe and reset it.
 */
export const dispatchState: { pending?: PendingDispatch } = {};

/**
 * The routing rule, in the words the model reads. It lives on the tool
 * (`promptGuidelines`) because that reaches every session the tool is registered
 * in; `APPEND_SYSTEM.md` carries the same paragraph for operators who read it,
 * but an already-installed copy of that file is theirs and is never refreshed.
 */
export const ROUTING_GUIDELINES = [
	"A bare message is ordinary chat. Answer directly, with tools as needed, when the operator asks a question, greets you, wants an explanation or an investigation, asks for a quick or single-file edit, or invokes a skill.",
	`Call ${START_JOB_TOOL} only for substantial engineering work: a feature that touches several files, work that needs tests, review and a commit, anything the operator calls a task, feature or plan, or when they ask for the loop.`,
	`Never call ${START_JOB_TOOL} for greetings, questions, pasted logs or error messages, or while a K-π job is live; if it refuses, answer directly.`,
	`After ${START_JOB_TOOL} queues a job, end your reply in one sentence.`,
] as const;

const GREETING_PATTERN = /^(?:hi|hello|hey|yo|thanks|thank you|ok|okay|cheers)\b/iu;
const QUESTION_PATTERN =
	/^(?:what|why|how|when|where|who|which|is|are|does|do|can|could|should|would|did)\b[\s\S]*\?\s*$/iu;

/** One line; a goal is an argument to `/kpi`, and the run store names paths after it. */
export function commandForGoal(goal: string, mode: JobMode): string {
	return `/kpi --mode ${mode} ${goal.replace(/\s+/gu, " ").trim()}`;
}

/** Why this goal is not a job, or `undefined` when it may be one. */
export function refuseGoal(goal: string): string | undefined {
	const text = goal.trim();
	if (text.length < MIN_GOAL_LENGTH) {
		return "goal is too short to be an engineering job; answer directly";
	}
	if (GREETING_PATTERN.test(text)) {
		return "greetings are answered directly, not run as jobs";
	}
	if (QUESTION_PATTERN.test(text)) {
		return "questions are answered directly, not run as jobs";
	}
	return undefined;
}

export interface RoutingRegistrationOptions {
	env?: NodeJS.ProcessEnv;
	agentDirectory?: string;
}

/**
 * How a bare message reaches the loop.
 *
 * Under `routing: auto` (the default) the input hook does nothing: the agent in
 * front of the operator reads the message with its full context and decides,
 * through `kpi_start_job`, whether it is a job at all. The tool does not run the
 * loop itself. `sendUserMessage` executes a slash command immediately, even while
 * the turn is streaming, so dispatching from inside the tool would nest the whole
 * graph inside one tool call; the tool records the request and `agent_end` sends
 * it, which makes the loop the next input rather than a side effect of this one.
 */
export function registerRouting(pi: ExtensionAPI, options: RoutingRegistrationOptions = {}): void {
	const routingFor = (cwd: string) => resolveRoutingMode(cwd, options.agentDirectory);

	pi.on("input", async (event, context) => {
		const text = event.text.trim();
		if (text.length === 0 || text.startsWith("/")) {
			return { action: "continue" };
		}
		if ((await routingFor(context.cwd)) !== "always") {
			return { action: "continue" };
		}
		// A live job owns the follow-up: the text steers the session already
		// running rather than starting a second job.
		if (isLiveJob(await readActiveJob(context.cwd))) {
			return { action: "continue" };
		}
		kModeState.enabled = true;
		return { action: "transform", text: commandForGoal(event.text, "gated"), images: event.images };
	});

	// Bus workers load the whole built-in but never start jobs; graph nodes get no
	// K-π tools at all. Only the session in front of the operator holds this one.
	if (hasWorkerDescriptor(options.env) || typeof pi.registerTool !== "function") {
		return;
	}

	pi.registerTool(
		defineTool({
			name: START_JOB_TOOL,
			label: "Start K-π Job",
			description:
				"Queue a K-π engineering job (specify → plan → implement → test → review → ship) for substantial, multi-file work. Not for questions, greetings, explanations, investigations, or quick single-file edits.",
			promptSnippet: `${START_JOB_TOOL}: queue the K-π loop for substantial engineering work; answer everything else directly`,
			promptGuidelines: [...ROUTING_GUIDELINES],
			parameters: Type.Object({
				goal: Type.String({
					description: `Imperative goal with its acceptance in one sentence, at least ${MIN_GOAL_LENGTH} characters`,
				}),
				mode: Type.Optional(Type.Union([Type.Literal("gated"), Type.Literal("autopilot")])),
				reason: Type.String({ description: "One line on why this needs the full loop rather than a direct edit" }),
			}),
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
				if ((await routingFor(ctx.cwd)) === "off") {
					throw new Error("K-π routing is off; the operator starts jobs explicitly with /kpi <goal>");
				}
				const refusal = refuseGoal(params.goal);
				if (refusal !== undefined) {
					throw new Error(`K-π job refused: ${refusal}`);
				}
				const live = await readActiveJob(ctx.cwd);
				if (isLiveJob(live)) {
					throw new Error(`K-π job ${live.jobId} is live; steer it with plain text or stop it with /kpi stop`);
				}
				if (dispatchState.pending !== undefined) {
					throw new Error(`a K-π job is already queued for this turn: ${dispatchState.pending.goal}`);
				}
				const mode: JobMode = params.mode ?? "gated";
				const goal = params.goal.replace(/\s+/gu, " ").trim();
				kModeState.enabled = true;
				dispatchState.pending = { goal, mode, reason: params.reason, text: commandForGoal(goal, mode) };
				if (ctx.hasUI) {
					ctx.ui.notify(`K-π job queued: ${goal}`, "info");
				}
				return {
					content: [
						{
							type: "text",
							text: `K-π job queued for: ${goal} (${mode}). It starts when this turn ends; finish your reply in one short sentence and do not call ${START_JOB_TOOL} again.`,
						},
					],
					details: { goal, mode, reason: params.reason, command: dispatchState.pending.text },
				};
			},
		}),
	);

	pi.on("agent_end", async () => {
		const pending = dispatchState.pending;
		if (pending === undefined) return;
		delete dispatchState.pending;
		pi.sendUserMessage(pending.text, { expandPromptTemplates: true });
	});
}
