import assert from "node:assert/strict";
import test from "node:test";

import {
	parseClientVersionRejection,
	summarizeRefreshFailure,
} from "../packages/coding-agent/src/kpi/extensions/accounts/errors.ts";

/** The verbatim assistant errorMessage Anthropic returns for an outdated Claude Code identity. */
const VERSION_REJECTION_BODY =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"Claude Code 2.1.75 does not support this model; version 2.1.251 or newer is required. Run \'claude update\', or update the Claude desktop app, then try again.","details":{"error_code":"claude_code_version_too_old"}},"request_id":"req_011CegQu2xW5e5oLygDDqtHQ"}';

/** The shape packages/ai/src/auth/oauth/anthropic.ts builds for a failed refresh, stack frames included. */
function refreshFailure(status: number, body: string): Error {
	return new Error(
		`Anthropic token refresh request failed. url=https://console.anthropic.com/v1/oauth/token; details=Error: HTTP request failed. status=${status}; url=https://console.anthropic.com/v1/oauth/token; body=${body}; stack=Error: HTTP request failed\n    at postJson (file:///opt/k-pi/dist/bundle/cli.js:10:20)\n    at refreshAnthropicToken (file:///opt/k-pi/dist/bundle/cli.js:11:5)`,
	);
}

test("parseClientVersionRejection reads the sent and required versions from the rejection body", () => {
	assert.deepEqual(parseClientVersionRejection(VERSION_REJECTION_BODY), { sent: "2.1.75", required: "2.1.251" });

	const codeOnly = parseClientVersionRejection('{"details":{"error_code":"claude_code_version_too_old"}}');
	assert.ok(codeOnly !== undefined, "the error code alone is still a version rejection");
	assert.equal(codeOnly.sent, undefined);
	assert.equal(codeOnly.required, undefined);

	assert.equal(parseClientVersionRejection('400 {"error":{"message":"You are out of extra usage"}}'), undefined);
	assert.equal(parseClientVersionRejection(undefined), undefined);
});

test("summarizeRefreshFailure never carries a stack trace", () => {
	assert.deepEqual(
		summarizeRefreshFailure(
			refreshFailure(400, '{"error":"invalid_grant","error_description":"refresh token has been revoked"}'),
		),
		{ kind: "invalid_grant" },
	);

	const http = summarizeRefreshFailure(refreshFailure(503, '{"error":"overloaded"}'));
	assert.equal(http.kind, "http");
	assert.ok(http.kind === "http" && http.status === 503);
	assert.ok(http.kind === "http" && !/stack=/u.test(http.summary), http.summary);
	assert.ok(http.kind === "http" && !/\n\s+at /u.test(http.summary), http.summary);
	assert.ok(http.kind === "http" && http.summary.length <= 160, `summary is ${http.summary.length} characters`);

	const transport = summarizeRefreshFailure(new Error("fetch failed"));
	assert.deepEqual(transport, { kind: "transport", summary: "fetch failed" });
});
