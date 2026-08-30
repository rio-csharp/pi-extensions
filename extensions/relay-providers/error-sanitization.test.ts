import assert from "node:assert/strict";
import test from "node:test";
import { redactRelayErrorText } from "./index.ts";

test("redacts OpenAI-style API-key tokens in relay errors", () => {
	const apiKey = ["sk", "proj", "1234567890abcdef"].join("-");
	assert.equal(
		redactRelayErrorText(`HTTP 401: invalid key ${apiKey} response`),
		"HTTP 401: invalid key <redacted> response",
	);
	assert.equal(redactRelayErrorText("quota exceeded for model"), "quota exceeded for model");
});
