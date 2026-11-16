import assert from "node:assert/strict";
import test from "node:test";
import { aliasPayloadField, applyAliasToPayload, readThinkingLevel, resolveRequestModelId } from "./aliases.ts";
import type { RelayModelConfig } from "./config.ts";

type AliasMap = NonNullable<RelayModelConfig["modelAliases"]>;

const LADDER: string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Same entries, keys written in reverse order: resolution must not depend on insertion order. */
function reversed(map: AliasMap): AliasMap {
	const reversedMap: AliasMap = {};
	for (const key of Object.keys(map).reverse()) {
		reversedMap[key as keyof AliasMap] = map[key as keyof AliasMap];
	}
	return reversedMap;
}

/** Every outcome must be the untouched picker ID or a value from this model's own alias map. */
function assertMemberOfAliases(baseId: string, aliases: AliasMap | undefined, levels: (string | undefined)[]): void {
	const aliasValues = aliases ? Object.values(aliases).filter((value): value is string => typeof value === "string") : [];
	const usable = aliasValues.filter((value) => value.trim().length > 0);
	const allowed = new Set<string>([...aliasValues, baseId]);
	for (const level of levels) {
		const resolved = resolveRequestModelId(baseId, aliases, level);
		assert(allowed.has(resolved), `level ${String(level)} resolved to a synthesized id: ${resolved}`);
		if (usable.length > 0) {
			assert.notEqual(resolved, baseId, `level ${String(level)} sent the synthetic picker ID upstream`);
		}
	}
}

test("an unconfigured model keeps its registration ID for every level", () => {
	for (const level of [...LADDER, undefined, "bogus"]) {
		assert.equal(resolveRequestModelId("relay-model", undefined, level), "relay-model");
	}
	assert.equal(resolveRequestModelId("relay-model", {}, "high"), "relay-model");
});

test("undefined behaves like off", () => {
	const aliases: AliasMap = { off: "m-off", minimal: "m-minimal", high: "m-high" };
	assert.equal(resolveRequestModelId("m", aliases, undefined), resolveRequestModelId("m", aliases, "off"));
	assert.equal(resolveRequestModelId("m", aliases, undefined), "m-off");

	// Without an "off" entry the ladder starts at the weakest real variant.
	const withoutOff: AliasMap = { high: "m-high", minimal: "m-minimal" };
	assert.equal(resolveRequestModelId("m", withoutOff, undefined), "m-minimal");
	assert.equal(resolveRequestModelId("m", withoutOff, undefined), resolveRequestModelId("m", withoutOff, "off"));
});

test("an exact match always wins", () => {
	const aliases: AliasMap = { low: "m-low", medium: "m-medium", high: "m-high", max: "m-max" };
	for (const level of ["low", "medium", "high", "max"]) {
		assert.equal(resolveRequestModelId("m", aliases, level), `m-${level}`);
	}
});

test("falls back to the weaker configured level before the stronger one", () => {
	const aliases: AliasMap = { low: "m-low", high: "m-high" };
	assert.equal(resolveRequestModelId("m", aliases, "medium"), "m-low");
	assert.equal(resolveRequestModelId("m", aliases, "max"), "m-high");
	assert.equal(resolveRequestModelId("m", aliases, "xhigh"), "m-high");
	assert.equal(resolveRequestModelId("m", aliases, "minimal"), "m-low");
});

test("falls back to the strongest configured level when nothing weaker exists", () => {
	const aliases: AliasMap = { max: "m-max" };
	assert.equal(resolveRequestModelId("m", aliases, "low"), "m-max");
	assert.equal(resolveRequestModelId("m", aliases, "medium"), "m-max");
	// Only "off"-ish/absent entries remain, so the weakest (here: only) configured level is used.
	assert.equal(resolveRequestModelId("m", aliases, undefined), "m-max");
});

test("resolution is independent of alias key insertion order", () => {
	const samples: AliasMap[] = [
		{ low: "m-low", medium: "m-medium", high: "m-high" },
		{ high: "m-high", max: "m-max", off: "m-off" },
		{ minimal: "m-minimal", max: "m-max" },
		{ xhigh: "m-xhigh" },
	];
	const levels = [...LADDER, undefined, "bogus"];
	for (const sample of samples) {
		for (const level of levels) {
			assert.equal(
				resolveRequestModelId("m", sample, level),
				resolveRequestModelId("m", reversed(sample), level),
				`insertion order changed the result for level ${String(level)}`,
			);
		}
	}
});

test("an empty-string alias counts as unconfigured", () => {
	const aliases: AliasMap = { low: "", medium: "m-medium" };
	assert.equal(resolveRequestModelId("m", aliases, "low"), "m-medium");
	assert.equal(resolveRequestModelId("m", aliases, "medium"), "m-medium");
	assert.equal(resolveRequestModelId("m", { low: "", high: " " }, undefined), "m");
	assert.equal(resolveRequestModelId("m", { high: " ", max: "m-max" }, "high"), "m-max");
	assert.equal(resolveRequestModelId("m", { low: "" }, "medium"), "m");
});

test("only ever returns the registration ID or a value from this model's alias map", () => {
	const configs: (AliasMap | undefined)[] = [
		undefined,
		{},
		{ low: "ds-v4-flash-low", medium: "ds-v4-flash-medium", high: "ds-v4-flash-high" },
		{ off: "ds-v4-flash-off", max: "ds-v4-flash-max" },
		{ minimal: "", high: "ds-v4-flash-high" },
	];
	const levels = [...LADDER, "bogus", "", undefined];
	for (const config of configs) {
		assertMemberOfAliases("ds-v4-flash", config, levels);
		if (config) assertMemberOfAliases("ds-v4-flash", reversed(config), levels);
	}
});

test("the alias survives a chained hook that returns undefined", async () => {
	const payload = { model: "picker-id", messages: [] };
	const seen: unknown[] = [];
	const result = await applyAliasToPayload(payload, "upstream-id", "openai-completions", (original) => {
		seen.push(original);
		return undefined;
	});
	assert.deepEqual(result, { model: "upstream-id", messages: [] });
	assert.equal(seen.length, 1, "the chained hook stopped running");
});

test("the alias is forced onto whatever object the chained hook returns", async () => {
	const result = await applyAliasToPayload(
		{ model: "picker-id" },
		"upstream-id",
		"openai-completions",
		(original) => ({
			...(original as Record<string, unknown>),
			model: "hook-set-this",
			temperature: 0.2,
		}),
	);
	assert.deepEqual(result, { model: "upstream-id", temperature: 0.2 });
});

test("a hook returning a non-object cannot drop the rewrite", async () => {
	const result = await applyAliasToPayload(
		{ model: "picker-id", messages: [] },
		"upstream-id",
		"openai-completions",
		() => "nonsense",
	);
	assert.deepEqual(result, { model: "upstream-id", messages: [] });
});

test("a non-object payload is left alone instead of throwing", async () => {
	assert.equal(await applyAliasToPayload(undefined, "upstream-id", "openai-completions"), undefined);
	assert.equal(await applyAliasToPayload("raw", "upstream-id", "openai-completions"), "raw");
	assert.equal(
		await applyAliasToPayload("raw", "upstream-id", "openai-completions", () => "hooked"),
		"hooked",
	);
});

test("writes modelId for Bedrock Converse and model for every other API", async () => {
	assert.equal(aliasPayloadField("bedrock-converse-stream"), "modelId");
	assert.equal(aliasPayloadField("openai-completions"), "model");
	assert.equal(aliasPayloadField("anthropic-messages"), "model");
	assert.equal(aliasPayloadField(undefined), "model");

	assert.deepEqual(
		await applyAliasToPayload({ modelId: "picker-id", messages: [] }, "upstream-id", "bedrock-converse-stream"),
		{ modelId: "upstream-id", messages: [] },
	);
	assert.deepEqual(
		await applyAliasToPayload({ model: "picker-id" }, "upstream-id", "openai-completions"),
		{ model: "upstream-id" },
	);
});

test("reads the thinking level from either stream options shape", () => {
	// Full stream() calls reach streamSimple with reasoningEffort instead of reasoning.
	assert.equal(readThinkingLevel({ reasoning: "high" } as never), "high");
	assert.equal(readThinkingLevel({ reasoningEffort: "low" } as never), "low");
	assert.equal(readThinkingLevel({ reasoning: "high", reasoningEffort: "low" } as never), "high");
	assert.equal(readThinkingLevel(undefined), undefined);
	assert.equal(readThinkingLevel({} as never), undefined);
});
