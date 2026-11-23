import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEFAULT_CONCURRENCY = 4;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 32;
const CONFIG_FILE = "subagent.json";

export interface SubagentConfig {
	concurrency: number;
	defaultModel?: string;
	warning?: string;
}

// Read on demand (never cached, no fs.watch) so edits apply to the next job without a pi reload.
export function loadSubagentConfig(dir: string = getAgentDir()): SubagentConfig {
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(dir, CONFIG_FILE), "utf8");
	} catch {
		return { concurrency: DEFAULT_CONCURRENCY };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { concurrency: DEFAULT_CONCURRENCY, warning: `${CONFIG_FILE} is not valid JSON; using default concurrency ${DEFAULT_CONCURRENCY}.` };
	}

	const values = parsed as { concurrency?: unknown; defaultModel?: unknown } | null;
	const config: SubagentConfig = { concurrency: DEFAULT_CONCURRENCY };
	const warnings: string[] = [];
	const value = values?.concurrency;
	if (typeof value === "number" && Number.isFinite(value)) {
		config.concurrency = Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, Math.floor(value)));
		if (config.concurrency !== value) warnings.push(`concurrency ${value} clamped to ${config.concurrency}.`);
	} else if (value !== undefined) {
		warnings.push(`concurrency must be a number; using default ${DEFAULT_CONCURRENCY}.`);
	}

	const defaultModel = values?.defaultModel;
	if (typeof defaultModel === "string" && defaultModel.trim()) {
		config.defaultModel = defaultModel.trim();
	} else if (defaultModel !== undefined) {
		warnings.push("defaultModel must be a non-empty model reference; using the parent model.");
	}
	if (warnings.length > 0) config.warning = `${CONFIG_FILE}: ${warnings.join(" ")}`;
	return config;
}
