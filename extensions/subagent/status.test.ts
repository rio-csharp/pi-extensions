import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatStatusTail, modelLabel } from "./status.ts";

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

test("shows the thinking level as its own field, never joined to the model name", () => {
	const tail = formatStatusTail({
		title: "audit",
		startedAt: Date.now(),
		usage: EMPTY_USAGE,
		model: "amr-link/deepseek-flash",
		thinking: "high",
	});
	assert(tail.startsWith("amr-link/deepseek-flash · high · "));
	assert(!tail.includes("deepseek-flash:high"));
	assert(!tail.includes("deepseek-flash-high"));
});

test("omits the thinking level when the child runs without one", () => {
	const tail = formatStatusTail({ title: "audit", startedAt: Date.now(), usage: EMPTY_USAGE, model: "amr-link/deepseek-flash" });
	assert(tail.startsWith("amr-link/deepseek-flash · "));
});

function contextWith(models: Array<{ provider: string; id: string; name: string }>): ExtensionContext {
	return {
		modelRegistry: {
			find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		},
	} as unknown as ExtensionContext;
}

test("shows the model's display name instead of its wire id", () => {
	const ctx = contextWith([{ provider: "amr-link", id: "deepseek-v4.1-flash", name: "deepseek-flash" }]);
	assert.equal(modelLabel(ctx, "amr-link/deepseek-v4.1-flash"), "amr-link/deepseek-flash");

	const opus = contextWith([{ provider: "qfg", id: "claude-opus-5.5", name: "Claude Opus 5.5" }]);
	assert.equal(modelLabel(opus, "qfg/claude-opus-5.5"), "qfg/Claude Opus 5.5");
});

test("falls back to the reference when the model is unknown, unnamed, or already bare", () => {
	const ctx = contextWith([{ provider: "qfg", id: "ghost", name: "   " }]);
	assert.equal(modelLabel(ctx, "qfg/ghost"), "qfg/ghost");
	assert.equal(modelLabel(ctx, "unknown/model"), "unknown/model");
	assert.equal(modelLabel(ctx, "bare-model"), "bare-model");
	assert.equal(modelLabel(ctx, undefined), undefined);
	assert.equal(modelLabel(ctx, "/leading-slash"), "/leading-slash");
});
