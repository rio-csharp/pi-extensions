import assert from "node:assert/strict";
import test from "node:test";
import { loadImageGenConfig } from "./config.ts";
import { buildDescription, buildModelArgumentDescription, buildModelMenu, buildSizeArgumentDescription, formatResultHeader } from "./prompt.ts";

const config = {
	providers: {
		"ai-pixel": { api: "openai" as const, baseUrl: "https://api.example/v1", apiKey: "sk-test" },
	},
	models: {
		flare: { id: "gpt-image-2.6-flare", provider: "ai-pixel", description: "Fast drafts." },
		sunburst: { id: "gpt-image-2.6-sunburst", provider: "ai-pixel", description: "Careful final assets." },
	},
	defaultModel: "flare",
	defaultQuality: "medium" as const,
	defaultSize: "1024x1024",
	pricePerImage: 0.02,
	outputDir: "generated",
	timeoutMs: 600_000,
	warnings: [],
};

test("size argument description lists the recommended sizes for both dialects", () => {
	const text = buildSizeArgumentDescription();
	for (const size of ["1024x1536", "2048x2048", "2720x1536", "1536x2720", "1664x2496", "2496x1664", "4096x4096"]) {
		assert.match(text, new RegExp(size));
	}
	assert.match(text, /multiples of 16/);
	assert.match(text, /multiples of 32/);
	assert.match(text, /4K/);
});

test("model descriptions reach the tool description", () => {
	const description = buildDescription(config);
	assert.match(description, /"flare" \(gpt-image-2\.6-flare\): Fast drafts\./);
	assert.match(description, /"sunburst" \(gpt-image-2\.6-sunburst\): Careful final assets\./);
	assert.match(description, /default is "flare"/);
	assert.match(description, /same per-image price/);
});

test("model argument description lists every alias with its description", () => {
	const text = buildModelArgumentDescription(config);
	assert.match(text, /"flare" = Fast drafts\./);
	assert.match(text, /"sunburst" = Careful final assets\./);
	assert.match(text, /Defaults to "flare"\./);
});

test("config-provided descriptions win over built-in ones", () => {
	const loaded = loadImageGenConfig("/nonexistent-agent-dir");
	assert.match(buildModelMenu(loaded), /gpt-image-2\.6-flare/);
	assert.match(buildModelMenu(loaded), /gpt-image-2\.6-sunburst/);
});

test("a free SenseNova default is described as the first choice", () => {
	const description = buildDescription({
		...config,
		providers: {
			...config.providers,
			sensenova: { api: "sensenova" as const, baseUrl: "https://token.sensenova.cn/v1", apiKey: "sk" },
		},
		defaultModel: "nova",
		models: {
			...config.models,
			nova: {
				id: "sensenova-u1.6-lite",
				provider: "sensenova",
				description: "Free native image model.",
				pricePerImage: 0,
			},
		},
	});
	assert.match(description, /"nova" is the default and costs nothing/);
	assert.doesNotMatch(description, /same per-image price/);

	const paid = buildDescription({
		...config,
		providers: {
			...config.providers,
			sensenova: { api: "sensenova" as const, baseUrl: "https://token.sensenova.cn/v1", apiKey: "sk" },
		},
		defaultModel: "nova",
		models: {
			...config.models,
			nova: { id: "sensenova-u1.6-lite", provider: "sensenova", description: "x", pricePerImage: 0.03 },
		},
	});
	assert.doesNotMatch(paid, /costs nothing/);
});

test("custom model sets skip the flare/sunburst pricing hint", () => {
	const description = buildDescription({
		...config,
		models: { other: { id: "some-image-model", description: "Only one model." } },
		defaultModel: "other",
	});
	assert.doesNotMatch(description, /same per-image price/);
	assert.match(description, /"other" \(some-image-model\): Only one model\./);
});

test("result header shows the per-image price with a currency symbol", () => {
	const header = formatResultHeader({
		modelId: "gpt-image-2.6-flare",
		quality: "low",
		requestedSize: "1024x1536",
		dimensions: { width: 1024, height: 1536 },
		elapsedMs: 97_100,
		costUsd: 0.02,
	});
	assert.equal(header, "gpt-image-2.6-flare · low · requested 1024x1536 · got 1024x1536 · 97.1s · $0.02");

	const withoutSize = formatResultHeader({
		modelId: "m",
		quality: "medium",
		requestedSize: "auto",
		elapsedMs: 1_000,
		costUsd: 0.05,
	});
	assert.equal(withoutSize, "m · medium · requested auto · 1.0s · $0.05");
});
