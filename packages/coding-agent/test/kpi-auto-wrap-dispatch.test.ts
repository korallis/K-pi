import { describe, expect, it, vi } from "vitest";

/**
 * Bare-message auto-wrap returns `{ action: "transform", text: "/kpi --mode gated …" }`.
 * AgentSession.prompt must re-dispatch extension commands after transform, or the
 * wrapped `/kpi` is sent as ordinary chat and no job starts (UAT-24).
 */
describe("auto-wrap command re-dispatch contract", () => {
	it("re-dispatches transformed /kpi text as an extension command", async () => {
		const executed: string[] = [];
		const emitInput = vi.fn(async (text: string) => {
			if (text.startsWith("/")) return { action: "continue" as const };
			return {
				action: "transform" as const,
				text: `/kpi --mode gated ${text}`,
			};
		});
		const tryExecute = vi.fn(async (text: string) => {
			if (text.startsWith("/kpi")) {
				executed.push(text);
				return true;
			}
			return false;
		});

		async function prompt(text: string) {
			if (text.startsWith("/")) {
				if (await tryExecute(text)) return "command";
			}
			const inputResult = await emitInput(text);
			if (inputResult.action === "handled") return "handled";
			let current = text;
			if (inputResult.action === "transform") {
				current = inputResult.text;
				if (current.trimStart().startsWith("/")) {
					if (await tryExecute(current.trimStart())) return "command-after-transform";
				}
			}
			return `chat:${current}`;
		}

		await expect(prompt("add a healthcheck")).resolves.toBe("command-after-transform");
		expect(executed).toEqual(["/kpi --mode gated add a healthcheck"]);
		expect(tryExecute).toHaveBeenCalledTimes(1);
		expect(emitInput).toHaveBeenCalledWith("add a healthcheck");
	});

	it("does not wrap slash commands", async () => {
		const emitInput = vi.fn(async (text: string) => {
			if (text.startsWith("/")) return { action: "continue" as const };
			return { action: "transform" as const, text: `/kpi --mode gated ${text}` };
		});
		const tryExecute = vi.fn(async (text: string) => text.startsWith("/accounts"));

		async function prompt(text: string) {
			if (text.startsWith("/")) {
				if (await tryExecute(text)) return "command";
			}
			const inputResult = await emitInput(text);
			if (inputResult.action === "transform") {
				const current = inputResult.text;
				if (current.trimStart().startsWith("/") && (await tryExecute(current.trimStart()))) {
					return "command-after-transform";
				}
			}
			return "chat";
		}

		await expect(prompt("/accounts")).resolves.toBe("command");
		expect(emitInput).not.toHaveBeenCalled();
		expect(tryExecute).toHaveBeenCalledWith("/accounts");
	});
});
