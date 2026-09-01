import assert from "node:assert/strict";
import test from "node:test";
import { joinParts } from "../src/join.js";

test("joinParts concatenates with a space", () => {
	assert.equal(joinParts("hello", "world"), "hello world");
});
