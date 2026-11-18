import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultModels, imageCostUsd, loadImageGenConfig } from "./config.ts";

function withAgentDir(
	files: Record<string, unknown>,
	run: (dir: string) => void,
	env: Record<string, string | undefined> = {},
): void {
	const dir = mkdtempSync(join(tmpdir(), "imagegen-config-"));
	const previous: Record<string, string | undefined> = {};
	try {
		for (const [key, value] of Object.entries(env)) {
			previous[key] = process.env[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
		}
		run(dir);
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	}
}

test("missing config yields built-in models and no warnings", () => {
	withAgentDir({}, (dir) => {
		const config = loadImageGenConfig(dir);
		assert.deepEqual(config.warnings, []);
		assert.deepEqual(Object.keys(config.models), ["flare", "sunburst"]);
		assert.equal(config.models.flare?.id, "gpt-image-2.6-flare");
		assert.equal(config.defaultModel, "flare");
		assert.equal(config.baseUrl, "");
		assert.equal(config.apiKey, "");
	});
});

test("reuses relay-providers credentials by provider id", () => {
	withAgentDir(
		{
			"imagegen.json": { provider: "ai-pixel" },
			"relay-providers.json": {
				providers: [
					{ id: "other", baseUrl: "https://other.example/v1", apiKey: "nope" },
					{ id: "ai-pixel", baseUrl: "https://api.ai-pixel.online/v1", apiKey: "sk-test" },
				],
			},
		},
		(dir) => {
			const config = loadImageGenConfig(dir);
			assert.equal(config.provider, "ai-pixel");
			assert.equal(config.baseUrl, "https://api.ai-pixel.online/v1");
			assert.equal(config.apiKey, "sk-test");
			assert.deepEqual(config.warnings, []);
		},
	);
});

test("expands env references and warns on unknown providers", () => {
	withAgentDir(
		{
			"imagegen.json": { provider: "missing" },
			"relay-providers.json": {
				providers: [{ id: "ai-pixel", baseUrl: "https://relay.example/v1", apiKey: "$IMAGEGEN_TEST_KEY" }],
			},
		},
		(dir) => {
			const config = loadImageGenConfig(dir);
			assert.equal(config.warnings.length, 1);
			assert.equal(config.apiKey, "");
		},
		{ IMAGEGEN_TEST_KEY: "sk-env" },
	);
});

test("explicit baseUrl and apiKey override the provider", () => {
	withAgentDir(
		{
			"imagegen.json": {
				provider: "ai-pixel",
				baseUrl: "https://direct.example/v1/",
				apiKey: "$IMAGEGEN_TEST_KEY",
			},
			"relay-providers.json": {
				providers: [{ id: "ai-pixel", baseUrl: "https://relay.example/v1", apiKey: "sk-relay" }],
			},
		},
		(dir) => {
			const config = loadImageGenConfig(dir);
			assert.equal(config.baseUrl, "https://direct.example/v1");
			assert.equal(config.apiKey, "sk-direct");
		},
		{ IMAGEGEN_TEST_KEY: "sk-direct" },
	);
});

test("invalid JSON and bad model entries fall back with warnings", () => {
	withAgentDir({ "imagegen.json": "{not json" }, (dir) => {
		const config = loadImageGenConfig(dir);
		assert.equal(config.warnings.length, 1);
		assert.deepEqual(config.models, defaultModels());
	});

	withAgentDir(
		{
			"imagegen.json": {
				models: {
					fast: { id: "gpt-image-2.6-flare", description: "drafts", quality: "low" },
					broken: { description: "no id" },
					"bad alias!": { id: "x" },
					slow: { id: "gpt-image-2.6-sunburst", quality: "bogus" },
				},
				defaultModel: "slow",
				defaultQuality: "auto",
				timeoutSeconds: 3,
			},
		},
		(dir) => {
			const config = loadImageGenConfig(dir);
			assert.deepEqual(Object.keys(config.models).sort(), ["fast", "flare", "slow", "sunburst"]);
			assert.equal(config.models.fast?.quality, "low");
			assert.equal(config.models.slow?.quality, undefined);
			assert.equal(config.defaultModel, "slow");
			assert.equal(config.defaultQuality, "auto");
			assert.equal(config.timeoutMs, 30_000);
			assert.equal(config.warnings.length, 3);
		},
	);
});

test("unknown defaultModel falls back to the first entry", () => {
	withAgentDir({ "imagegen.json": { defaultModel: "nope", models: { only: { id: "m-1" } } } }, (dir) => {
		const config = loadImageGenConfig(dir);
		assert.equal(config.defaultModel, "flare");
		assert.equal(config.models.only?.id, "m-1");
		assert.equal(config.warnings.length, 1);
	});
});

test("price defaults to 0.02 per image and can be overridden", () => {
	withAgentDir({}, (dir) => {
		assert.equal(loadImageGenConfig(dir).pricePerImage, 0.02);
	});

	withAgentDir(
		{
			"imagegen.json": {
				pricePerImage: 0.05,
				models: { cheap: { id: "m-1", pricePerImage: 0.01 }, broken: { id: "m-2", pricePerImage: "free" } },
			},
		},
		(dir) => {
			const config = loadImageGenConfig(dir);
			assert.equal(config.pricePerImage, 0.05);
			assert.equal(config.models.cheap?.pricePerImage, 0.01);
			assert.equal(config.models.broken?.pricePerImage, 0);
			assert.equal(config.warnings.length, 1);
		},
	);
});

test("imageCostUsd bills per image", () => {
	assert.equal(imageCostUsd(0.02, 1), 0.02);
	assert.equal(imageCostUsd(0.02, 3), 0.06);
	assert.equal(imageCostUsd(0.105, 2), 0.21);
	assert.equal(imageCostUsd(0.02, 0), 0);
	assert.equal(imageCostUsd(Number.NaN, 1), 0);
});

test("rejects credential-bearing base URLs", () => {
	withAgentDir({ "imagegen.json": { baseUrl: "https://user:pass@example.com/v1" } }, (dir) => {
		const config = loadImageGenConfig(dir);
		assert.equal(config.baseUrl, "");
		assert.equal(config.warnings.length, 1);
	});
});
