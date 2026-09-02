import assert from "node:assert/strict";
import test from "node:test";

import { login } from "../../src/auth/api.ts";
import { isFresh } from "../../src/auth/session.ts";

test("login issues a fresh session for the user", () => {
	const session = login("ada", 1_000);

	assert.equal(session.user, "ada");
	assert.equal(isFresh(session.issuedAt, 2_000), true);
});
