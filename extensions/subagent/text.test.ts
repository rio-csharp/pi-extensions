import assert from "node:assert/strict";
import test from "node:test";
import { TITLE_CAP, clampTitle } from "./text.ts";

test("trims and collapses whitespace in a title", () => {
	assert.equal(clampTitle("  review   the   diff  "), "review the diff");
	assert.equal(clampTitle(undefined), "");
	assert.equal(clampTitle(""), "");
});

test("keeps a title at the cap and trims longer ones without cutting a surrogate pair", () => {
	assert.equal(clampTitle("x".repeat(TITLE_CAP)), "x".repeat(TITLE_CAP));
	assert.equal(clampTitle("x".repeat(TITLE_CAP + 40)).length, TITLE_CAP);

	const emoji = "🧪";
	const trimmed = clampTitle(emoji.repeat(TITLE_CAP));
	assert.equal(Array.from(trimmed).length, TITLE_CAP);
	assert.equal(trimmed, emoji.repeat(TITLE_CAP));
	assert(!trimmed.includes("\uFFFD"));
});
