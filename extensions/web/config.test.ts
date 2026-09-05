import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadWebConfig } from "./config.ts";

function withConfig(file: unknown, run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "web-config-"));
	try {
		if (file !== undefined) {
			writeFileSync(join(dir, "web.json"), typeof file === "string" ? file : JSON.stringify(file));
		}
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("missing file falls back to duckduckgo then bing", () => {
	withConfig(undefined, (dir) => {
		const config = loadWebConfig(dir);
		assert.deepEqual(config.searchProviders, ["duckduckgo", "bing"]);
		assert.deepEqual(config.warnings, []);
	});
});

test("invalid JSON falls back to defaults with a warning", () => {
	withConfig("not json{", (dir) => {
		const config = loadWebConfig(dir);
		assert.deepEqual(config.searchProviders, ["duckduckgo", "bing"]);
		assert.equal(config.warnings.length, 1);
	});
});

test("accepts mixed string and object providers in order", () => {
	withConfig({
		searchProviders: [
			{ id: "searxng", endpoint: "https://searx.example.com" },
			"bing",
		],
	}, (dir) => {
		const config = loadWebConfig(dir);
		assert.deepEqual(config.searchProviders, [
			{ id: "searxng", endpoint: "https://searx.example.com/", basicAuth: undefined },
			"bing",
		]);
	});
});

test("skips unknown providers and invalid searxng entries with warnings", () => {
	withConfig({
		searchProviders: [
			"google",
			{ id: "searxng" },
			{ id: "searxng", endpoint: "ftp://searx.example.com" },
			{ id: "searxng", endpoint: "https://user:pass@searx.example.com" },
			"bing",
		],
	}, (dir) => {
		const config = loadWebConfig(dir);
		assert.deepEqual(config.searchProviders, ["bing"]);
		assert.equal(config.warnings.length, 4);
	});
});

test("expands basicAuth env references and skips providers with unset references", () => {
	process.env.PI_WEB_TEST_AUTH = "user:pass";
	try {
		withConfig({
			searchProviders: [
				{ id: "searxng", endpoint: "https://a.example.com", basicAuth: "$PI_WEB_TEST_AUTH" },
				{ id: "searxng", endpoint: "https://b.example.com", basicAuth: "$PI_WEB_TEST_MISSING" },
			],
		}, (dir) => {
			const config = loadWebConfig(dir);
			assert.deepEqual(config.searchProviders, [
				{ id: "searxng", endpoint: "https://a.example.com/", basicAuth: "user:pass" },
			]);
			assert.equal(config.warnings.length, 1);
		});
	} finally {
		delete process.env.PI_WEB_TEST_AUTH;
	}
});

test("parses fetchRelay with env-token expansion", () => {
	process.env.PI_WEB_TEST_TOKEN = "secret-token";
	try {
		withConfig({
			fetchRelay: { endpoint: "https://fetch.example.com", token: "$PI_WEB_TEST_TOKEN" },
		}, (dir) => {
			const config = loadWebConfig(dir);
			assert.deepEqual(config.fetchRelay, { endpoint: "https://fetch.example.com/", token: "secret-token" });
		});
	} finally {
		delete process.env.PI_WEB_TEST_TOKEN;
	}
});

test("rejects insecure or incomplete fetchRelay entries", () => {
	withConfig({
		fetchRelay: { endpoint: "http://fetch.example.com", token: "t" },
	}, (dir) => {
		const config = loadWebConfig(dir);
		assert.equal(config.fetchRelay, undefined);
		assert.equal(config.warnings.length, 1);
	});
	withConfig({
		fetchRelay: { endpoint: "https://fetch.example.com" },
	}, (dir) => {
		assert.equal(loadWebConfig(dir).fetchRelay, undefined);
	});
});

test("falls back to defaults when every configured provider is unusable", () => {
	withConfig({ searchProviders: ["google"] }, (dir) => {
		const config = loadWebConfig(dir);
		assert.deepEqual(config.searchProviders, ["duckduckgo", "bing"]);
		assert.ok(config.warnings.length >= 2);
	});
});
