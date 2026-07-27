import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { AgentScope } from "./agents.ts";
import type { SingleResult, SubagentDetails, SubagentTimelineState, UsageStats } from "./types.ts";

interface TimelineRenderContext {
	args: SubagentArgs;
	state: SubagentTimelineState;
	lastComponent: Component | undefined;
	isError: boolean;
}

interface SubagentArgs {
	agent?: string;
	title?: string;
	task?: string;
	agentScope?: AgentScope;
	tasks?: Array<{ agent: string; title: string; task: string }>;
	chain?: Array<{ agent: string; title: string; task: string }>;
}

class EmptyComponent implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

function formatClock(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

function formatElapsed(milliseconds: number): string {
	if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
	const seconds = milliseconds / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${Math.floor(seconds % 60).toString().padStart(2, "0")}s`;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function compactTitle(value: string | undefined, fallback: string): string {
	const text = value?.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim() || fallback;
	return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function summarizeTitles(items: Array<{ title: string }> | undefined): string {
	if (!items?.length) return "";
	const shown = items.slice(0, 2).map((item) => compactTitle(item.title, "untitled"));
	return `${shown.join("; ")}${items.length > 2 ? `; +${items.length - 2} more` : ""}`;
}

function describeStart(args: SubagentArgs): string {
	const scope = args.agentScope ?? "user";
	if (args.chain?.length) {
		const titles = summarizeTitles(args.chain);
		return `chain · ${args.chain.length} steps${titles ? ` · ${titles}` : ""} · ${scope}`;
	}
	if (args.tasks?.length) {
		const titles = summarizeTitles(args.tasks);
		return `parallel · ${args.tasks.length} tasks${titles ? ` · ${titles}` : ""} · ${scope}`;
	}
	const title = compactTitle(args.title, compactTitle(args.task, "untitled task"));
	return `${title} · ${args.agent ?? "unknown agent"} · ${scope}`;
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function aggregateUsage(results: SingleResult[]): UsageStats {
	const total: UsageStats = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
	for (const result of results) {
		total.input += result.usage.input;
		total.output += result.usage.output;
		total.cacheRead += result.usage.cacheRead;
		total.cacheWrite += result.usage.cacheWrite;
		total.cost += result.usage.cost;
		total.turns += result.usage.turns;
	}
	return total;
}

function formatUsage(results: SingleResult[]): string {
	const usage = aggregateUsage(results);
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	parts.push(
		`↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} R${formatTokens(usage.cacheRead)} W${formatTokens(usage.cacheWrite)}`,
	);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" · ");
}

function getTextResult(result: any): string {
	const block = result?.content?.find((item: any) => item?.type === "text");
	return typeof block?.text === "string" ? block.text : "";
}

function describeFinish(args: SubagentArgs, details: SubagentDetails | undefined): string {
	if (!details?.results.length) return describeStart(args);
	const failed = details.results.filter(isFailedResult).length;
	const succeeded = details.results.length - failed;

	if (details.mode === "parallel") {
		return `parallel · ${succeeded}/${details.results.length} succeeded${failed ? ` · ${failed} failed` : ""}`;
	}
	if (details.mode === "chain") {
		return `chain · ${succeeded}/${details.results.length} steps${failed ? ` · ${failed} failed` : ""}`;
	}

	const result = details.results[0];
	const title = compactTitle(args.title, compactTitle(args.task, "untitled task"));
	return `${title} · ${result?.agent ?? args.agent ?? "unknown agent"}`;
}

function classifyOutcome(
	result: any,
	context: TimelineRenderContext,
): "completed" | "failed" | "canceled" {
	const details = result.details as SubagentDetails | undefined;
	const text = getTextResult(result);
	if (/^Canceled:/i.test(text)) return "canceled";
	if (context.isError || details?.results.some(isFailedResult)) return "failed";
	if (/^(Invalid parameters|Too many parallel tasks|Agent .*failed|Chain stopped)/i.test(text)) return "failed";
	return "completed";
}

export const subagentTimelineRenderer = {
	renderShell: "self" as const,

	renderCall(
		args: SubagentArgs,
		theme: Theme,
		context: TimelineRenderContext,
	) {
		const state = context.state;
		state.startedAt ??= Date.now();
		const timestamp = theme.fg("dim", `[${formatClock(state.startedAt)}]`);
		const icon = theme.fg("accent", "→");
		const label = theme.fg("toolTitle", theme.bold("subagent started"));
		const content = `${timestamp} ${icon} ${label} · ${describeStart(args)}`;
		state.startText ??= context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		state.startText.setText(content);
		return state.startText;
	},

	renderResult(
		result: any,
		options: { isPartial: boolean },
		theme: Theme,
		context: TimelineRenderContext,
	) {
		if (options.isPartial) return context.lastComponent ?? new EmptyComponent();

		const state = context.state;
		state.startedAt ??= Date.now();
		state.finishedAt ??= Date.now();
		const outcome = classifyOutcome(result, context);
		const color = outcome === "completed" ? "success" : outcome === "failed" ? "error" : "warning";
		const icon = outcome === "completed" ? "✓" : outcome === "failed" ? "✗" : "○";
		const timestamp = theme.fg("dim", `[${formatClock(state.finishedAt)}]`);
		const label = theme.fg("toolTitle", theme.bold(`subagent ${outcome}`));
		const details = result.details as SubagentDetails | undefined;
		const summary = describeFinish(context.args, details);
		const elapsed = formatElapsed(state.finishedAt - state.startedAt);
		const usage = details?.results.length ? formatUsage(details.results) : "";
		const content = `${timestamp} ${theme.fg(color, icon)} ${label} · ${summary} · ${elapsed}${usage ? ` · ${usage}` : ""}`;

		state.resultText ??= context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		state.resultText.setText(content);
		return state.resultText;
	},
};
