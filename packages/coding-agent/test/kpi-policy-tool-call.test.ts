import { describe, expect, it } from "vitest";
import { DEFAULT_ACTIVE_POLICY_STATE, evaluateToolCall, type PolicyConfig } from "../src/kpi/extensions/policy.ts";

const policy: PolicyConfig = {
	deny: [],
	allow: [],
	commit: { chat: "allow", gated: "confirm", autopilot: "after-release" },
	unknown: { chat: "allow", gated: "confirm", autopilot: "deny" },
};

function bashEvent(command: string) {
	return {
		type: "tool_call" as const,
		toolName: "bash",
		toolCallId: "call_test",
		input: { command },
	};
}

describe("policy tool_call coverage for model-reachable bash", () => {
	it("denies git push on the bash tool_call path (model-reachable)", async () => {
		const decision = await evaluateToolCall(bashEvent("git push origin HEAD"), {
			cwd: process.cwd(),
			policy,
			active: { ...DEFAULT_ACTIVE_POLICY_STATE, mode: "gated" },
		});
		expect(decision.kind).toBe("deny");
		if (decision.kind === "deny") {
			expect(decision.reason).toMatch(/push|Policy denied/i);
		}
	});

	it("allows only the job branch push, only after release.approved, on the bash tool_call path", async () => {
		const push = "git push -u origin kpi/20260903-add-healthcheck";
		for (const mode of ["gated", "autopilot"] as const) {
			const before = await evaluateToolCall(bashEvent(push), {
				cwd: process.cwd(),
				policy,
				active: { ...DEFAULT_ACTIVE_POLICY_STATE, mode },
			});
			expect(before.kind, mode).toBe("deny");
			const after = await evaluateToolCall(bashEvent(push), {
				cwd: process.cwd(),
				policy,
				active: { ...DEFAULT_ACTIVE_POLICY_STATE, mode, releaseApproved: true },
			});
			expect(after.kind, mode).toBe("allow");
			const pullRequest = await evaluateToolCall(
				bashEvent("gh pr create --head kpi/20260903-add-healthcheck --fill"),
				{
					cwd: process.cwd(),
					policy,
					active: { ...DEFAULT_ACTIVE_POLICY_STATE, mode, releaseApproved: true },
				},
			);
			expect(pullRequest.kind, mode).toBe("allow");
		}
		for (const command of [
			"git push origin main",
			"git push --force origin kpi/20260903-add-healthcheck",
			"git push origin --delete kpi/20260903-add-healthcheck",
			"git push origin v0.2.1",
			"gh pr merge --auto",
		]) {
			const decision = await evaluateToolCall(bashEvent(command), {
				cwd: process.cwd(),
				policy,
				active: { ...DEFAULT_ACTIVE_POLICY_STATE, mode: "autopilot", releaseApproved: true },
			});
			expect(decision.kind, command).toBe("deny");
		}
	});

	it("denies force-push, production deploy, and rm -rf on bash tool_call", async () => {
		for (const command of [
			"git push --force origin HEAD",
			"kubectl apply -f deploy.yaml",
			"rm -rf /tmp/uat-should-not-matter-but-deny",
		]) {
			const decision = await evaluateToolCall(bashEvent(command), {
				cwd: process.cwd(),
				policy,
				active: { ...DEFAULT_ACTIVE_POLICY_STATE, mode: "autopilot" },
			});
			expect(decision.kind, command).toBe("deny");
		}
	});

	it("requires confirm for gated git commit with a diff-stat question", async () => {
		const decision = await evaluateToolCall(bashEvent("git commit -m 'feat: x'"), {
			cwd: process.cwd(),
			policy,
			active: { ...DEFAULT_ACTIVE_POLICY_STATE, mode: "gated" },
			readDiffStat: async () => ({ filesChanged: 2, insertions: 10, deletions: 3 }),
		});
		expect(decision.kind).toBe("confirm");
		if (decision.kind === "confirm") {
			expect(decision.title).toBe("Approve git commit");
			expect(decision.question).toContain("2 files changed, 10 insertions(+), 3 deletions(-)");
			expect(decision.question).toContain("against HEAD");
		}
	});

	it("denies autopilot git commit without release.approved", async () => {
		const decision = await evaluateToolCall(bashEvent("git commit -m 'feat: x'"), {
			cwd: process.cwd(),
			policy,
			active: {
				...DEFAULT_ACTIVE_POLICY_STATE,
				mode: "autopilot",
				releaseApproved: false,
			},
			readDiffStat: async () => ({ filesChanged: 1, insertions: 1, deletions: 0 }),
		});
		expect(decision.kind).toBe("deny");
		if (decision.kind === "deny") {
			expect(decision.reason).toMatch(/release\.approved/);
		}
	});
});
