import type { Static } from "typebox";
import type { SubagentJobsParams, SubagentParams } from "./schema.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function omitBlank(input: Record<string, unknown>, keys: readonly string[]): void {
	for (const key of keys) {
		const value = input[key];
		if (value == null || (typeof value === "string" && !value.trim())) delete input[key];
	}
}

function normalizeOverrides(input: Record<string, unknown>): void {
	omitBlank(input, ["model", "thinking", "cwd", "systemPrompt", "tools"]);
	if (typeof input.thinking === "string") input.thinking = input.thinking.trim().toLowerCase();
}

export function prepareSubagentArguments(args: unknown): Static<typeof SubagentParams> {
	if (!isRecord(args)) return args as Static<typeof SubagentParams>;
	const input = { ...args };
	normalizeOverrides(input);
	omitBlank(input, ["title", "task"]);
	for (const key of ["tasks", "chain"]) {
		const items = input[key];
		if (!Array.isArray(items)) continue;
		input[key] = items.map((item: unknown) => {
			if (!isRecord(item)) return item;
			const copy = { ...item };
			normalizeOverrides(copy);
			return copy;
		});
		if (items.length > 0) delete input.cwd;
	}
	return input as Static<typeof SubagentParams>;
}

export function prepareSubagentJobsArguments(args: unknown): Static<typeof SubagentJobsParams> {
	if (!isRecord(args)) return args as Static<typeof SubagentJobsParams>;
	const { action, jobId, instruction, taskIndex, model, thinking, tools, includeOutput } = args;
	let input: Record<string, unknown>;
	switch (action) {
		case "list": return { action };
		case "status": input = { action, jobId, includeOutput }; break;
		case "steer": input = { action, jobId, taskIndex, instruction }; break;
		case "resume": input = { action, jobId, instruction, model, thinking, tools }; break;
		case "cancel": input = { action, jobId }; break;
		default: return args as Static<typeof SubagentJobsParams>;
	}
	omitBlank(input, ["jobId", "instruction", "taskIndex", "includeOutput"]);
	normalizeOverrides(input);
	if (typeof input.jobId === "string") input.jobId = input.jobId.trim();
	return input as Static<typeof SubagentJobsParams>;
}
