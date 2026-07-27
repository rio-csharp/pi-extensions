import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SingleResult, UsageStats } from "./types.ts";

const STATUS_KEY_PREFIX = "subagent-status-";
const STATUS_TICK_MS = 1000;

interface RunningSubagent {
	agent: string;
	title: string;
	startedAt: number;
	usage: UsageStats;
}

function statusKey(runId: number): string {
	return `${STATUS_KEY_PREFIX}${runId.toString().padStart(6, "0")}`;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatElapsed(startedAt: number): string {
	const totalSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
	return `${seconds}s`;
}

function formatStartTime(startedAt: number): string {
	return new Date(startedAt).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

/**
 * Publishes live subagent state through setStatus(). It never owns the footer;
 * whichever footer is active (for example relay-footer) remains responsible
 * for rendering extension statuses.
 */
export function createSubagentStatusPublisher(pi: ExtensionAPI) {
	let nextRunId = 0;
	let statusTimer: ReturnType<typeof setInterval> | undefined;
	const runningSubagents = new Map<number, RunningSubagent>();

	const publishStatuses = (ctx: ExtensionContext) => {
		const multiple = runningSubagents.size > 1;
		for (const [index, [runId, running]] of Array.from(runningSubagents.entries()).entries()) {
			const usage = running.usage;
			const tokenStats = `↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} R${formatTokens(usage.cacheRead)} W${formatTokens(usage.cacheWrite)}`;
			const prefix = multiple ? `subagent ${index + 1}` : "subagent";
			const text = `${prefix}: ${running.title} (${running.agent}) [start ${formatStartTime(running.startedAt)} · ${formatElapsed(running.startedAt)} · ${tokenStats} · $${usage.cost.toFixed(4)}]`;
			ctx.ui.setStatus(statusKey(runId), ctx.ui.theme.fg("accent", text));
		}
	};

	const stopTimerIfIdle = () => {
		if (runningSubagents.size !== 0 || !statusTimer) return;
		clearInterval(statusTimer);
		statusTimer = undefined;
	};

	const whileRunning = async <T>(
		agentName: string,
		title: string | undefined,
		ctx: ExtensionContext,
		run: (onStatusUpdate: (result: SingleResult) => void) => Promise<T>,
	): Promise<T> => {
		const runId = nextRunId++;
		runningSubagents.set(runId, {
			agent: agentName,
			title: title?.trim() || agentName,
			startedAt: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		});
		publishStatuses(ctx);
		statusTimer ??= setInterval(() => publishStatuses(ctx), STATUS_TICK_MS);
		statusTimer.unref?.();

		const onStatusUpdate = (result: SingleResult) => {
			const running = runningSubagents.get(runId);
			if (!running) return;
			running.usage = { ...result.usage };
			publishStatuses(ctx);
		};

		try {
			return await run(onStatusUpdate);
		} finally {
			runningSubagents.delete(runId);
			ctx.ui.setStatus(statusKey(runId), undefined);
			// Renumber labels such as "subagent 1" after a parallel task exits.
			publishStatuses(ctx);
			stopTimerIfIdle();
		}
	};

	pi.on("session_shutdown", (_event, ctx) => {
		for (const runId of runningSubagents.keys()) {
			ctx.ui.setStatus(statusKey(runId), undefined);
		}
		runningSubagents.clear();
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = undefined;
	});

	return { whileRunning };
}
