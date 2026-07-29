import type { Theme, ToolRenderContext } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { AgentScope } from "./agents.ts";
import type {
	BackgroundJobStatus,
	SingleResult,
	SubagentDetails,
	SubagentJobsDetails,
	SubagentJobsRenderState,
	SubagentTimelineState,
	UsageStats,
} from "./types.ts";

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
	background?: boolean;
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
	const totalSeconds = Math.floor(milliseconds / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}m${seconds.toString().padStart(2, "0")}s`;
	return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

function shortJobId(jobId: string | undefined): string {
	if (!jobId) return "unknown";
	const prefix = jobId.startsWith("sub-") ? "sub-" : "";
	const body = prefix ? jobId.slice(prefix.length) : jobId;
	return body.length > 8 ? `${prefix}${body.slice(0, 8)}` : jobId;
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
	if (details?.background && details.jobId) {
		return `background · ${details.jobStatus ?? "running"} · ${details.jobId}`;
	}
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
): "running" | "completed" | "failed" | "canceled" {
	const details = result.details as SubagentDetails | undefined;
	const text = getTextResult(result);
	if (details?.background && (details.jobStatus === "running" || details.jobStatus === "canceling")) return "running";
	if (/^Canceled:/i.test(text) || details?.jobStatus === "canceled") return "canceled";
	if (context.isError || details?.results.some(isFailedResult)) return "failed";
	if (details?.jobStatus === "failed" || details?.jobStatus === "interrupted") return "failed";
	if (/^(Invalid parameters|Too many (parallel|background) tasks|Agent .*failed|Chain stopped)/i.test(text)) return "failed";
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

		const details = result.details as SubagentDetails | undefined;
		// Background execution has its own completion timeline message. Keep only
		// the original "subagent started" row when the start tool returns.
		if (details?.background) return context.lastComponent ?? new EmptyComponent();

		const state = context.state;
		state.startedAt ??= Date.now();
		state.finishedAt ??= Date.now();
		const outcome = classifyOutcome(result, context);
		const color = outcome === "completed" ? "success" : outcome === "failed" ? "error" : outcome === "running" ? "accent" : "warning";
		const icon = outcome === "completed" ? "✓" : outcome === "failed" ? "✗" : outcome === "running" ? "↗" : "○";
		const timestamp = theme.fg("dim", `[${formatClock(state.finishedAt)}]`);
		const label = theme.fg("toolTitle", theme.bold(`subagent ${outcome}`));
		const summary = describeFinish(context.args, details);
		const elapsed = formatElapsed(state.finishedAt - state.startedAt);
		const usage = details?.results.length ? formatUsage(details.results) : "";
		const content = `${timestamp} ${theme.fg(color, icon)} ${label} · ${summary} · ${elapsed}${usage ? ` · ${usage}` : ""}`;

		state.resultText ??= context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		state.resultText.setText(content);
		return state.resultText;
	},
};

function supervisorVisual(status: BackgroundJobStatus | undefined): {
	label: string;
	icon: string;
	color: "success" | "error" | "warning" | "accent";
} {
	switch (status) {
		case "completed":
			return { label: "completed", icon: "✓", color: "success" };
		case "canceled":
			return { label: "canceled", icon: "○", color: "warning" };
		case "running":
		case "canceling":
			return { label: status, icon: "↗", color: "accent" };
		case "failed":
		case "interrupted":
		default:
			return { label: status ?? "failed", icon: "✗", color: "error" };
	}
}

function taskCounts(details: SubagentDetails | undefined): {
	total: number;
	succeeded: number;
	failed: number;
	pending: number;
	running: number;
} {
	if (details?.tasks) {
		return details.tasks.reduce(
			(counts, task) => {
				counts[task.state ?? (task.completed ? "succeeded" : "pending")]++;
				return counts;
			},
			{ total: details.tasks.length, succeeded: 0, failed: 0, pending: 0, running: 0 },
		);
	}
	const results = details?.results ?? [];
	const failed = results.filter(isFailedResult).length;
	return { total: results.length, succeeded: results.length - failed, failed, pending: 0, running: 0 };
}

function formatTaskCounts(details: SubagentDetails | undefined): string {
	const counts = taskCounts(details);
	return `${counts.succeeded} succeeded · ${counts.failed} failed · ${counts.pending} pending · ${counts.running} running`;
}

/** Render supervisor notifications as one compact row, regardless of Ctrl+O. */
export function renderSubagentSupervisorMessage(message: any, theme: Theme): Component {
	const details = message.details as SubagentDetails | undefined;
	const finishedAt = details?.finishedAt ?? Date.now();
	const startedAt = details?.startedAt ?? finishedAt;
	const visual = supervisorVisual(details?.jobStatus);
	const timestamp = theme.fg("dim", `[${formatClock(finishedAt)}]`);
	const label = theme.fg("toolTitle", theme.bold(`subagent job ${visual.label}`));
	const counts = taskCounts(details);
	const countSummary = counts.failed === 0 && counts.pending === 0 && counts.running === 0
		? `${counts.succeeded}/${counts.total} succeeded`
		: `${counts.succeeded}/${counts.total} succeeded · ${counts.failed} failed · ${counts.pending} pending · ${counts.running} running`;
	const elapsed = formatElapsed(Math.max(0, finishedAt - startedAt));
	const content = `${timestamp} ${theme.fg(visual.color, visual.icon)} ${label} · ${countSummary} · ${elapsed}`;
	return new Text(content, 0, 0);
}

interface SubagentJobsArgs {
	action?: "list" | "status" | "resume" | "cancel";
	jobId?: string;
	includeOutput?: boolean;
}

function jobsDetails(result: any): SubagentDetails[] {
	const details = resultDetails(result);
	if (!details) return [];
	return "jobs" in details ? details.jobs : [details];
}

function resultDetails(
	result: any,
): SubagentDetails | SubagentJobsDetails | undefined {
	const details = result?.details;
	if (!details || typeof details !== "object") return undefined;
	if ("jobs" in details && Array.isArray(details.jobs)) return details as SubagentJobsDetails;
	if ("mode" in details && Array.isArray(details.results)) return details as SubagentDetails;
	return undefined;
}

function describeJobsResult(args: SubagentJobsArgs, result: any, isError: boolean): string {
	const jobs = jobsDetails(result);
	if (args.action === "list") {
		const statuses = new Map<BackgroundJobStatus, number>();
		for (const job of jobs) {
			if (job.jobStatus) statuses.set(job.jobStatus, (statuses.get(job.jobStatus) ?? 0) + 1);
		}
		const summary = [...statuses.entries()].map(([status, count]) => `${count} ${status}`).join(" · ");
		return `${jobs.length} job${jobs.length === 1 ? "" : "s"}${summary ? ` · ${summary}` : ""}`;
	}

	const details = jobs[0];
	if (!details) {
		const text = compactTitle(getTextResult(result), isError ? "failed" : "done");
		return `${shortJobId(args.jobId)} · ${text}`;
	}
	const elapsed = formatElapsed(Math.max(0, (details.finishedAt ?? Date.now()) - (details.startedAt ?? Date.now())));
	return `${shortJobId(details.jobId ?? args.jobId)} · ${details.jobStatus ?? (isError ? "failed" : "completed")} · ${formatTaskCounts(details)} · ${elapsed}`;
}

function updateJobsCall(
	args: SubagentJobsArgs,
	theme: Theme,
	context: ToolRenderContext<SubagentJobsRenderState, SubagentJobsArgs>,
): Text {
	const state = context.state;
	state.calledAt ??= Date.now();
	const settled = state.resultDetails !== undefined;
	const failed = context.isError || state.isError;
	const icon = !context.executionStarted
		? theme.fg("dim", "○")
		: !settled
			? theme.fg("accent", "↗")
			: failed
				? theme.fg("error", "✗")
				: theme.fg("success", "✓");
	const action = args.action ?? "unknown";
	const invocation = action === "list"
		? "list"
		: `${action} · ${shortJobId(args.jobId)}${action === "status" && args.includeOutput ? " · output requested" : ""}`;
	const summary = settled
		? describeJobsResult(args, { details: state.resultDetails }, Boolean(failed))
		: invocation;
	const timestamp = theme.fg("dim", `[${formatClock(state.calledAt)}]`);
	const label = theme.fg("toolTitle", theme.bold("subagent_jobs"));
	state.callText ??= context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	state.callText.setText(`${timestamp} ${icon} ${label} · ${summary}`);
	return state.callText;
}

/** Compact call/result renderer; Ctrl+O never reveals task output. */
export const subagentJobsRenderer = {
	renderShell: "self" as const,

	renderCall(
		args: SubagentJobsArgs,
		theme: Theme,
		context: ToolRenderContext<SubagentJobsRenderState, SubagentJobsArgs>,
	): Component {
		return updateJobsCall(args, theme, context);
	},

	renderResult(
		result: any,
		options: { isPartial: boolean },
		theme: Theme,
		context: ToolRenderContext<SubagentJobsRenderState, SubagentJobsArgs>,
	): Component {
		if (options.isPartial) return context.lastComponent ?? new EmptyComponent();
		const details = resultDetails(result);
		stateFromResult(context.state, details, context.isError);
		updateJobsCall(context.args, theme, context);
		return context.lastComponent ?? new EmptyComponent();
	},
};

function stateFromResult(
	state: SubagentJobsRenderState,
	details: SubagentDetails | SubagentJobsDetails | undefined,
	isError: boolean,
): void {
	state.resultDetails = details && "jobs" in details ? details : { jobs: details ? [details] : [] };
	state.isError = isError;
}
