import assert from "node:assert/strict";
import test from "node:test";

import { login } from "../../src/auth/api.ts";
import { normalizeUser } from "../../src/auth/login.ts";

test("login issues a session for the normalized user", () => {
	assert.equal(login(normalizeUser("  Ada ")).user, "ada");
});
