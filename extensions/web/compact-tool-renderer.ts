import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, type Component } from "@earendil-works/pi-tui";

interface ToolRenderContext<TState, TArgs> {
	args: TArgs;
	toolCallId: string;
	invalidate: () => void;
	lastComponent: Component | undefined;
	state: TState;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ROW_TICK_MS = 100;

export interface CompactRenderState {
	calledAt?: number;
	startedAt?: number;
	finishedAt?: number;
	outputLines?: number;
	callText?: Text;
}

export interface CompactRendererOptions {
	observeResult?: (
		result: any,
		options: { isPartial: boolean },
		state: CompactRenderState,
	) => void;
}

export interface CompactRenderer {
	readonly renderShell: "self";
	renderCall: (
		args: Record<string, any>,
		theme: Theme,
		context: ToolRenderContext<CompactRenderState, Record<string, any>>,
	) => Component;
	renderResult: (
		result: any,
		options: { isPartial: boolean },
		theme: Theme,
		context: ToolRenderContext<CompactRenderState, Record<string, any>>,
	) => Component;
	dispose(): void;
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
	return `${(milliseconds / 1000).toFixed(1)}s`;
}

export function createCompactRenderer(
	name: string,
	formatInvocation: (args: Record<string, any>, theme: Theme) => string,
	options: CompactRendererOptions = {},
): CompactRenderer {
	let spinnerIndex = 0;
	let rowTicker: ReturnType<typeof setInterval> | undefined;
	const rowInvalidators = new Map<string, () => void>();

	const ensureRowTicker = () => {
		if (rowTicker) return;
		rowTicker = setInterval(() => {
			spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
			for (const invalidate of rowInvalidators.values()) invalidate();
		}, ROW_TICK_MS);
		rowTicker.unref?.();
	};

	const stopRowTickerIfIdle = () => {
		if (rowInvalidators.size !== 0 || !rowTicker) return;
		clearInterval(rowTicker);
		rowTicker = undefined;
	};

	const updateCallText = (
		args: Record<string, any>,
		theme: Theme,
		context: ToolRenderContext<CompactRenderState, Record<string, any>>,
	): Text => {
		const state = context.state;
		const now = Date.now();
		state.calledAt ??= now;
		if (context.executionStarted) state.startedAt ??= now;
		if (!context.isPartial) state.finishedAt ??= now;

		const running = context.executionStarted && context.isPartial;
		if (running) {
			rowInvalidators.set(context.toolCallId, context.invalidate);
			ensureRowTicker();
		} else if (!context.isPartial) {
			rowInvalidators.delete(context.toolCallId);
			stopRowTickerIfIdle();
		}

		const icon = !context.executionStarted
			? theme.fg("dim", "○")
			: context.isPartial
				? theme.fg("accent", SPINNER_FRAMES[spinnerIndex]!)
				: context.isError
					? theme.fg("error", "✗")
					: theme.fg("success", "✓");

		let status = "";
		if (state.startedAt !== undefined) {
			const end = state.finishedAt ?? now;
			status += theme.fg("dim", ` · ${formatElapsed(end - state.startedAt)}`);
		}
		if (running && state.outputLines !== undefined) {
			status += theme.fg(
				"dim",
				` · ${state.outputLines} output line${state.outputLines === 1 ? "" : "s"}`,
			);
		}

		const timestamp = theme.fg("dim", `[${formatClock(state.calledAt)}]`);
		const toolName = theme.fg("toolTitle", theme.bold(name));
		const prefix = `${timestamp} ${icon} ${toolName}${status}`;
		const invocation = formatInvocation(args, theme);

		let output: string;
		if (invocation.includes("\n")) {
			const lines = invocation.split("\n");
			const indent = " ".repeat(visibleWidth(prefix) + 3);
			output = `${prefix} · ${lines[0] ?? ""}`;
			for (const line of lines.slice(1)) output += `\n${indent}${line}`;
		} else {
			output = `${prefix} · ${invocation}`;
		}

		let text = state.callText;
		if (!text && context.lastComponent instanceof Text) text = context.lastComponent;
		text ??= new Text("", 0, 0);
		state.callText = text;
		text.setText(output);
		return text;
	};

	return {
		renderShell: "self",

		renderCall(args, theme, context) {
			return updateCallText(args, theme, context);
		},

		renderResult(result, renderOptions, theme, context) {
			options.observeResult?.(result, renderOptions, context.state);
			updateCallText(context.args, theme, context);
			return context.lastComponent ?? new EmptyComponent();
		},

		dispose() {
			if (rowTicker) clearInterval(rowTicker);
			rowTicker = undefined;
			rowInvalidators.clear();
		},
	};
}
