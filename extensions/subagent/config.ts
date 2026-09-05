import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEFAULT_CONCURRENCY = 4;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 32;
const CONFIG_FILE = "subagent.json";

export interface SubagentConfig {
	concurrency: number;
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

	const value = (parsed as { concurrency?: unknown } | null)?.concurrency;
	if (value === undefined) return { concurrency: DEFAULT_CONCURRENCY };
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return { concurrency: DEFAULT_CONCURRENCY, warning: `${CONFIG_FILE}: concurrency must be a number; using default ${DEFAULT_CONCURRENCY}.` };
	}
	const clamped = Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, Math.floor(value)));
	if (clamped !== value) {
		return { concurrency: clamped, warning: `${CONFIG_FILE}: concurrency ${value} clamped to ${clamped}.` };
	}
	return { concurrency: clamped };
}
