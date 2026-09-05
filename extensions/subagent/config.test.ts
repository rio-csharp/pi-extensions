import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONCURRENCY, loadSubagentConfig } from "./config.ts";

test("loadSubagentConfig falls back to the default when the file is missing", () => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-config-"));
	try {
		assert.deepEqual(loadSubagentConfig(dir), { concurrency: DEFAULT_CONCURRENCY });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadSubagentConfig reads a valid concurrency", () => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-config-"));
	try {
		writeFileSync(join(dir, "subagent.json"), JSON.stringify({ concurrency: 8 }));
		assert.deepEqual(loadSubagentConfig(dir), { concurrency: 8 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadSubagentConfig clamps out-of-range values with a warning", () => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-config-"));
	try {
		writeFileSync(join(dir, "subagent.json"), JSON.stringify({ concurrency: 999 }));
		const config = loadSubagentConfig(dir);
		assert.equal(config.concurrency, 32);
		assert.match(config.warning ?? "", /clamped to 32/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadSubagentConfig rejects invalid JSON and non-number values", () => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-config-"));
	try {
		writeFileSync(join(dir, "subagent.json"), "not json{");
		let config = loadSubagentConfig(dir);
		assert.equal(config.concurrency, DEFAULT_CONCURRENCY);
		assert.match(config.warning ?? "", /not valid JSON/);

		writeFileSync(join(dir, "subagent.json"), JSON.stringify({ concurrency: "many" }));
		config = loadSubagentConfig(dir);
		assert.equal(config.concurrency, DEFAULT_CONCURRENCY);
		assert.match(config.warning ?? "", /must be a number/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
