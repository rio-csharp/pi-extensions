import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { terminalSanitize } from "./security.ts";
import { effectiveModel, formatTokens } from "./text.ts";
import type { SingleResult, UsageStats } from "./types.ts";

// Neutral convention: a "footer-row-" key asks the active footer for a dedicated line.
const STATUS_KEY_PREFIX = "footer-row-subagent-";
const STATUS_SUMMARY_KEY = `${STATUS_KEY_PREFIX}summary`;
const STATUS_TICK_MS = 1000;
const MAX_STATUS_ROWS = 5;
// Zero width, not stripped by sanitizers: the footer scrolls only the text before it.
const SCROLL_MARKER = "\u200B";

interface RunningSubagent {
	title: string;
	startedAt: number;
	usage: UsageStats;
	model?: string;
	thinking?: string;
}

function statusKey(runId: number): string {
	return `${STATUS_KEY_PREFIX}${runId.toString().padStart(6, "0")}`;
}

/** `provider/model-id` becomes `provider/model name`, which is shorter and reads better. */
export function modelLabel(ctx: ExtensionContext, reference: string | undefined): string | undefined {
	if (!reference) return undefined;
	const slashIndex = reference.indexOf("/");
	if (slashIndex <= 0) return reference;
	const provider = reference.slice(0, slashIndex);
	const name = ctx.modelRegistry.find(provider, reference.slice(slashIndex + 1))?.name?.trim();
	return name ? `${provider}/${name}` : reference;
}

/** Everything after the scrolling title: model name, thinking level, timing, tokens, cost. */
export function formatStatusTail(entry: RunningSubagent): string {
	const usage = entry.usage;
	return [
		entry.model ? terminalSanitize(entry.model) : undefined,
		entry.thinking,
		formatStartTime(entry.startedAt),
		formatRunningElapsed(entry.startedAt),
		`↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} R${formatTokens(usage.cacheRead)}`,
		`$${usage.cost.toFixed(4)}`,
	]
		.filter((part): part is string => Boolean(part))
		.join(" · ");
}

function formatStartTime(startedAt: number): string {
	return new Date(startedAt).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function formatRunningElapsed(startedAt: number): string {
	const totalSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
	return `${seconds}s`;
}

export function createStatusPublisher(pi: ExtensionAPI) {
	let nextRunId = 0;
	let statusTimer: ReturnType<typeof setInterval> | undefined;
	let generation = 0;
	let uiActive = false;
	const running = new Map<number, RunningSubagent>();
	const publishedKeys = new Set<string>();

	const publish = (ctx: ExtensionContext) => {
		if (!uiActive) return;
		const entries = Array.from(running.entries());
		const visibleCount = entries.length <= MAX_STATUS_ROWS ? entries.length : MAX_STATUS_ROWS - 1;
		const visible = entries.slice(0, visibleCount);
		const hiddenCount = entries.length - visible.length;
		const desiredKeys = new Set<string>();
		for (const [index, [runId, entry]] of visible.entries()) {
			const key = statusKey(runId);
			desiredKeys.add(key);
			const head = terminalSanitize(entry.title);
			const tail = formatStatusTail(entry);
			const rowNumber = `${index + 1}: `;
			const row = tail ? `${rowNumber}${SCROLL_MARKER}${head}${SCROLL_MARKER} · ${tail}` : `${rowNumber}${head}`;
			ctx.ui.setStatus(key, ctx.ui.theme.fg("accent", row));
		}

		if (hiddenCount > 0) {
			desiredKeys.add(STATUS_SUMMARY_KEY);
			const noun = hiddenCount === 1 ? "subagent" : "subagents";
			ctx.ui.setStatus(STATUS_SUMMARY_KEY, ctx.ui.theme.fg("dim", `… ${hiddenCount} more ${noun} running`));
		}

		for (const key of publishedKeys) {
			if (!desiredKeys.has(key)) ctx.ui.setStatus(key, undefined);
		}
		publishedKeys.clear();
		for (const key of desiredKeys) publishedKeys.add(key);
	};

	const stopTimerIfIdle = () => {
		if (running.size !== 0 || !statusTimer) return;
		clearInterval(statusTimer);
		statusTimer = undefined;
	};

	const whileRunning = async <T>(
		title: string | undefined,
		ctx: ExtensionContext,
		run: (onStatusUpdate: (result: SingleResult) => void) => Promise<T>,
		model?: string,
		thinking?: string,
	): Promise<T> => {
		const runId = nextRunId++;
		const runGeneration = generation;
		running.set(runId, {
			title: terminalSanitize(title?.trim() || "subagent"),
			startedAt: Date.now(),
			model: modelLabel(ctx, model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined)),
			thinking,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		});
		publish(ctx);
		statusTimer ??= setInterval(() => publish(ctx), STATUS_TICK_MS);
		statusTimer.unref?.();

		const onStatusUpdate = (result: SingleResult) => {
			if (!uiActive || runGeneration !== generation) return;
			const entry = running.get(runId);
			if (!entry) return;
			entry.usage = { ...result.usage };
			entry.model = modelLabel(ctx, effectiveModel(result.provider, result.model)) ?? entry.model;
			publish(ctx);
		};

		try {
			return await run(onStatusUpdate);
		} finally {
			running.delete(runId);
			if (uiActive && runGeneration === generation) {
				ctx.ui.setStatus(statusKey(runId), undefined);
				publishedKeys.delete(statusKey(runId));
				publish(ctx);
			}
			stopTimerIfIdle();
		}
	};

	pi.on("session_start", () => {
		generation++;
		uiActive = true;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		uiActive = false;
		generation++;
		for (const key of publishedKeys) ctx.ui.setStatus(key, undefined);
		publishedKeys.clear();
		running.clear();
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = undefined;
	});

	return { whileRunning };
}
