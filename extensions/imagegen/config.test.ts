import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultModels, imageCostUsd, loadImageGenConfig, modelApi, modelEndpoint, modelProblem, configProblem } from "./config.ts";

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

test("missing config yields built-in models, no providers and no warnings", () => {
	withAgentDir({}, (dir) => {
		const config = loadImageGenConfig(dir);
		assert.deepEqual(config.warnings, []);
		assert.deepEqual(Object.keys(config.models), ["flare", "sunburst"]);
		assert.equal(config.models.flare?.id, "gpt-image-2.6-flare");
		assert.equal(config.defaultModel, "flare");
		assert.deepEqual(config.providers, {});
		// Built-in models name no provider, so nothing is sent anywhere until one is configured.
		assert.match(modelProblem(config, "flare") ?? "", /names no provider/);
		assert.match(configProblem(config) ?? "", /no providers/);
	});
});

test("providers hold baseUrl and apiKey, and models name one", () => {
	withAgentDir(
		{
			"imagegen.json": {
				providers: {
					"ai-pixel": { baseUrl: "https://direct.example/v1/", apiKey: "$IMAGEGEN_TEST_KEY" },
					sensenova: { api: "sensenova", baseUrl: "https://nova.example/v1", apiKey: "sk-nova" },
				},
				models: {
					flare: { id: "gpt-image-2.6-flare", provider: "ai-pixel" },
					nova: { id: "sensenova-u1.6-lite", provider: "sensenova" },
				},
			},
			"relay-providers.json": {
				providers: [{ id: "ai-pixel", baseUrl: "https://relay.example/v1", apiKey: "sk-relay" }],
			},
		},
		(dir) => {
			const config = loadImageGenConfig(dir);
			assert.deepEqual(config.warnings, []);
			// The trailing slash is normalized away; relay-providers.json is never read.
			assert.deepEqual(modelEndpoint(config, "flare"), {
				provider: "ai-pixel",
				baseUrl: "https://direct.example/v1",
				apiKey: "sk-direct",
			});
			assert.deepEqual(modelEndpoint(config, "nova"), {
				provider: "sensenova",
				baseUrl: "https://nova.example/v1",
				apiKey: "sk-nova",
			});
			assert.equal(modelApi(config, "flare"), "openai");
			assert.equal(modelApi(config, "nova"), "sensenova");
		},
		{ IMAGEGEN_TEST_KEY: "sk-direct" },
	);
});

test("an unset apiKey reference warns and leaves that provider without a key", () => {
	withAgentDir(
		{
			"imagegen.json": {
				providers: { nova: { api: "sensenova", apiKey: "$IMAGEGEN_TEST_MISSING_KEY", baseUrl: "https://nova.example/v1" } },
				models: { nova: { id: "sensenova-u1.6-lite", provider: "nova" } },
			},
		},
		(dir) => {
			const config = loadImageGenConfig(dir);
			assert.equal(config.warnings.length, 1);
			assert.match(config.warnings[0] ?? "", /apiKey reference is unset/);
			assert.equal(config.providers.nova?.apiKey, "");
			assert.match(modelProblem(config, "nova") ?? "", /provider "nova" has no API key/);
		},
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

test("two providers let one config mix OpenAI and SenseNova models", () => {
	withAgentDir(
		{
			"imagegen.json": {
				defaultModel: "nova",
				providers: {
					"ai-pixel": { baseUrl: "https://api.ai-pixel.online/v1", apiKey: "sk-openai" },
					sensenova: { api: "sensenova", baseUrl: "https://token.sensenova.cn/v1/", apiKey: "sk-nova" },
				},
				models: {
					flare: { id: "gpt-image-2.6-flare", provider: "ai-pixel" },
					nova: { id: "sensenova-u1.6-lite", provider: "sensenova", description: "2K/4K" },
				},
			},
			"relay-providers.json": {
				providers: [{ id: "ai-pixel", baseUrl: "https://relay.example/v1", apiKey: "sk-relay" }],
			},
		},
		(dir) => {
			const config = loadImageGenConfig(dir);
			assert.deepEqual(config.warnings, []);
			assert.equal(modelApi(config, "nova"), "sensenova");
			assert.equal(modelApi(config, "flare"), "openai");
			// The trailing slash is normalized away before the request path is appended.
			assert.deepEqual(modelEndpoint(config, "nova"), {
				provider: "sensenova",
				baseUrl: "https://token.sensenova.cn/v1",
				apiKey: "sk-nova",
			});
			assert.deepEqual(modelEndpoint(config, "flare"), {
				provider: "ai-pixel",
				baseUrl: "https://api.ai-pixel.online/v1",
				apiKey: "sk-openai",
			});
			assert.equal(modelProblem(config, "nova"), undefined);
		},
	);
});

test("a provider owns the api shape and an unknown one falls back to openai", () => {
	withAgentDir(
		{
			"imagegen.json": {
				providers: {
					nova: { api: "sensenova", baseUrl: "https://nova.example/v1", apiKey: "sk-nova" },
					broken: { api: "dall-e", baseUrl: "https://broken.example/v1", apiKey: "sk" },
				},
				models: {
					broken: { id: "m-1", provider: "broken" },
					fine: { id: "m-2", provider: "nova" },
				},
			},
		},
		(dir) => {
			const config = loadImageGenConfig(dir);
			assert.equal(config.providers.broken?.api, "openai");
			assert.equal(modelApi(config, "broken"), "openai");
			assert.equal(modelApi(config, "fine"), "sensenova");
			assert.equal(config.warnings.length, 1);
			assert.match(config.warnings[0] ?? "", /unknown api/);
		},
	);
});

test("a model that names no provider is never guessed onto an endpoint", () => {
	withAgentDir(
		{
			"imagegen.json": {
				providers: {
					"ai-pixel": { baseUrl: "https://api.ai-pixel.online/v1", apiKey: "sk-openai" },
					sensenova: { api: "sensenova", baseUrl: "https://token.sensenova.cn/v1", apiKey: "sk-nova" },
				},
				models: { orphan: { id: "m-1" }, fine: { id: "m-2", provider: "sensenova" } },
			},
		},
		(dir) => {
			const config = loadImageGenConfig(dir);
			assert.deepEqual(modelEndpoint(config, "orphan"), { provider: undefined, baseUrl: undefined, apiKey: undefined });
			assert.match(modelProblem(config, "orphan") ?? "", /model "orphan" names no provider/);
			assert.equal(modelProblem(config, "fine"), undefined);
		},
	);
});

test("the retired defaultProvider key warns instead of picking an endpoint", () => {
	withAgentDir(
		{
			"imagegen.json": {
				providers: { only: { baseUrl: "https://only.example/v1", apiKey: "sk" } },
				defaultProvider: "only",
			},
		},
		(dir) => {
			const config = loadImageGenConfig(dir);
			assert.equal(config.warnings.length, 1);
			assert.match(config.warnings[0] ?? "", /top-level "defaultProvider" is not used/);
			assert.match(modelProblem(config, "flare") ?? "", /names no provider/);
		},
	);
});

test("a model pointing at an undefined provider warns and is unusable", () => {
	withAgentDir(
		{
			"imagegen.json": {
				providers: { ok: { baseUrl: "https://ok.example/v1", apiKey: "sk" } },
				models: {
					nova: { id: "sensenova-u1.6-lite", provider: "sensenova" },
					good: { id: "m-2", provider: "ok" },
				},
			},
		},
		(dir) => {
			const config = loadImageGenConfig(dir);
			assert.match(config.warnings.join("\n"), /model "nova" uses provider "sensenova", which is not defined/);
			assert.match(modelProblem(config, "nova") ?? "", /provider "sensenova" is not defined/);
			assert.equal(modelProblem(config, "good"), undefined);
			assert.equal(configProblem(config), undefined);
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

test("normalizes only the path of a provider base URL with query parameters", () => {
	withAgentDir(
		{ "imagegen.json": { providers: { p: { baseUrl: "https://example.com/v1///?route=blue/", apiKey: "sk" } } } },
		(dir) => {
			assert.equal(loadImageGenConfig(dir).providers.p?.baseUrl, "https://example.com/v1?route=blue/");
		},
	);
});

test("rejects credential-bearing provider base URLs", () => {
	withAgentDir(
		{ "imagegen.json": { providers: { p: { baseUrl: "https://user:pass@example.com/v1", apiKey: "sk" } } } },
		(dir) => {
			const config = loadImageGenConfig(dir);
			assert.equal(config.providers.p, undefined);
			assert.equal(config.warnings.length, 1);
		},
	);
});
