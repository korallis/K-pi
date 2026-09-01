import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "../../../core/extensions/types.ts";

import { readActiveJob } from "../control-plane.ts";
import { assertClaimInModule, readDuneStack } from "../stack.ts";
import { BackgroundBus, type WorkerLauncher } from "./spawn.ts";

export function registerBackgroundBus(pi: ExtensionAPI, launcher?: WorkerLauncher): void {
	const buses = new Map<string, BackgroundBus>();
	const activeBus = async (cwd: string): Promise<BackgroundBus> => {
		const job = await readActiveJob(cwd);
		if (job === undefined) throw new Error("No active K-π job");
		let bus = buses.get(job.jobId);
		if (bus === undefined) {
			bus = new BackgroundBus(cwd, job.directory, launcher);
			buses.set(job.jobId, bus);
		}
		return bus;
	};

	pi.registerTool(
		defineTool({
			name: "spawn_background",
			label: "Spawn Background",
			description: "Start one local background K-π worker; at most two workers and one writer",
			parameters: Type.Object({
				role: Type.Union([
					Type.Literal("implementer"),
					Type.Literal("reviewer"),
					Type.Literal("tester"),
					Type.Literal("arena"),
					Type.Literal("explorer"),
				]),
				prompt: Type.String(),
				model: Type.Optional(Type.String()),
				tools: Type.Optional(Type.Array(Type.String())),
			}),
			async execute(_id, params, _signal, _update, context) {
				const worker = await (await activeBus(context.cwd)).spawn(params);
				const details = { agent_id: worker.agentId, session_path: worker.sessionPath, pid: worker.pid };
				return { content: [{ type: "text", text: JSON.stringify(details) }], details };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "communicate",
			label: "Communicate",
			description: "Send steering or follow-up input to a background K-π worker",
			parameters: Type.Object({
				to: Type.String(),
				message: Type.String(),
				deliverAs: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
			}),
			async execute(_id, params, _signal, _update, context) {
				await (await activeBus(context.cwd)).communicate(params.to, params.message, params.deliverAs);
				return { content: [{ type: "text", text: "delivered" }], details: { delivered: true } };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "claim_path",
			label: "Claim Path",
			description: "Acquire an exclusive same-tree path lease for a writer worker",
			parameters: Type.Object({ agent_id: Type.String(), path: Type.String() }),
			async execute(_id, params, _signal, _update, context) {
				const job = await readActiveJob(context.cwd);
				if (job !== undefined) {
					try {
						const stack = await readDuneStack(job.directory);
						const module = stack.modules[0];
						if (module === undefined) throw new Error("Dune stack has no current module");
						assertClaimInModule(context.cwd, params.path, module);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
				}
				await (await activeBus(context.cwd)).claim(params.agent_id, params.path);
				return { content: [{ type: "text", text: `claimed ${params.path}` }], details: params };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "release_path",
			label: "Release Path",
			description: "Release a same-tree path lease",
			parameters: Type.Object({ agent_id: Type.String(), path: Type.String() }),
			async execute(_id, params, _signal, _update, context) {
				await (await activeBus(context.cwd)).release(params.agent_id, params.path);
				return { content: [{ type: "text", text: `released ${params.path}` }], details: params };
			},
		}),
	);
}
