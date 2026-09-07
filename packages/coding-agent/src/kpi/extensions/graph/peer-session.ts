import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "../../../core/extensions/types.ts";
import type { PeerClient, PeerMessage, PeerRuntime } from "../bus/peer-runtime.ts";

/** One authenticated logical peer; the existing broker owns identity and replay. */
export class GraphPeerBinding {
	readonly client: PeerClient;
	private readonly runtime: PeerRuntime;
	readonly agentId: string;
	private turns: Promise<unknown> = Promise.resolve();
	private closed = false;
	constructor(runtime: PeerRuntime, agentId: string, client: PeerClient) {
		this.runtime = runtime;
		this.agentId = agentId;
		this.client = client;
	}

	/** Graph assignments and idle-message turns never race on a native session. */
	run<T>(turn: () => Promise<T>): Promise<T> {
		const pending = this.turns.then(() => {
			if (this.closed) throw new Error("graph peer is detached; resume its job");
			return turn();
		});
		this.turns = pending.catch(() => undefined);
		return pending;
	}

	attach(deliver: (message: PeerMessage) => Promise<void>): void {
		this.runtime.attachDelivery(this.agentId, (message) => this.run(() => deliver(message)));
	}

	tools(): ToolDefinition[] {
		const result = (details: unknown) => ({
			content: [{ type: "text" as const, text: JSON.stringify(details) }],
			details,
		});
		return [
			defineTool({
				name: "communicate",
				label: "Communicate",
				description:
					"Send a durable direct or room message to a discovered peer. Sender is authenticated. Delivery starts a native peer turn after its current assignment; acceptance is not completion.",
				parameters: Type.Object({
					to: Type.Optional(Type.String()),
					room: Type.Optional(Type.String()),
					message: Type.String(),
					id: Type.Optional(Type.String()),
					replyTo: Type.Optional(Type.String()),
				}),
				execute: async (_id, params) =>
					result(
						await this.client.request("send", {
							to: params.to,
							room: params.room,
							text: params.message,
							id: params.id,
							replyTo: params.replyTo,
							deliverAs: "followUp",
						}),
					),
			}),
			defineTool({
				name: "peers",
				label: "Peers",
				description:
					"Discover authenticated peers, join or leave job rooms, replay your scoped inbox, or acknowledge the next handled message.",
				parameters: Type.Object({
					action: Type.Union(["discover", "join", "leave", "inbox", "ack"].map((value) => Type.Literal(value))),
					room: Type.Optional(Type.String()),
					after: Type.Optional(Type.Number()),
					id: Type.Optional(Type.String()),
				}),
				execute: async (_id, params) =>
					result(
						await this.client.request(
							params.action,
							params.action === "join" || params.action === "leave"
								? { room: params.room }
								: params.action === "ack"
									? { id: params.id }
									: params.action === "inbox"
										? { after: params.after }
										: {},
						),
					),
			}),
		];
	}

	/** Detach this in-process incarnation, not its durable identity or job broker. */
	close(): void {
		this.closed = true;
		this.client.close();
		void this.turns.finally(() => this.runtime.deactivate(this.agentId));
	}
}
