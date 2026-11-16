import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";

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
	callComponent?: CompactInvocationComponent;
	expanded?: ExpandedSlot;
}

interface ExpandedSlot {
	state: Record<string, any>;
	lastComponent?: Component;
}

export interface ExpandedRenderers {
	renderCall?: (
		args: Record<string, any>,
		theme: Theme,
		context: ToolRenderContext<CompactRenderState, Record<string, any>>,
	) => Component;
	renderResult?: (
		result: any,
		options: { isPartial: boolean },
		theme: Theme,
		context: ToolRenderContext<CompactRenderState, Record<string, any>>,
	) => Component;
}

export interface CompactRendererOptions {
	observeResult?: (
		result: any,
		options: { isPartial: boolean },
		state: CompactRenderState,
	) => void;
	/** Renderers used while the row is expanded, so the compact row can reveal the full built-in view. */
	expanded?: () => ExpandedRenderers | undefined;
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

const MAX_INVOCATION_LINES = 3;
const ELLIPSIS = "...";
const COLLAPSED_GLYPH = "▸";
const EXPANDED_GLYPH = "▾";

/** What the collapsed and expanded states look like, for tests and for the hint text. */
export const EXPAND_AFFORDANCE = { collapsed: COLLAPSED_GLYPH, expanded: EXPANDED_GLYPH } as const;

function normalizeInvocation(invocation: string): string {
	const normalized = invocation.replace(/\r\n|\r/g, "\n");
	return normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
}

function layoutInvocation(prefix: string, invocation: string): {
	text: string;
	continuationIndent: number;
} {
	const lines = normalizeInvocation(invocation).split("\n");
	const continuationIndent = visibleWidth(prefix) + 3;
	const indent = " ".repeat(continuationIndent);
	return {
		text: `${prefix} · ${lines[0] ?? ""}${lines.slice(1).map((line) => `\n${indent}${line}`).join("")}`,
		continuationIndent,
	};
}

function capInvocationLines(
	wrappedLines: string[],
	continuationIndent: number,
	width: number,
): string[] {
	if (wrappedLines.length <= MAX_INVOCATION_LINES) return wrappedLines;

	const ellipsis = truncateToWidth(ELLIPSIS, width, "");
	const maxIndent = Math.max(0, width - visibleWidth(ellipsis));
	const indent = " ".repeat(Math.min(continuationIndent, maxIndent));

	return [
		...wrappedLines.slice(0, MAX_INVOCATION_LINES - 1),
		`${indent}${ellipsis}`,
	];
}

export class CompactInvocationComponent implements Component {
	private prefix = "";
	private invocation = "";
	private cachedWidth?: number;
	private cachedLines?: string[];

	setContent(prefix: string, invocation: string): void {
		if (prefix === this.prefix && invocation === this.invocation) return;
		this.prefix = prefix;
		this.invocation = invocation;
		this.invalidate();
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, Math.floor(width));
		if (this.cachedLines && this.cachedWidth === renderWidth) return this.cachedLines;

		const { text, continuationIndent } = layoutInvocation(this.prefix, this.invocation);
		const wrapped = wrapTextWithAnsi(text.replace(/\t/g, "   "), renderWidth);
		const lines = capInvocationLines(wrapped, continuationIndent, renderWidth);

		this.cachedWidth = renderWidth;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
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
		expandable: boolean,
	): CompactInvocationComponent => {
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
		const affordance = expandable ? `${theme.fg("dim", context.expanded ? EXPANDED_GLYPH : COLLAPSED_GLYPH)} ` : "";

		let component = state.callComponent;
		if (!component && context.lastComponent instanceof CompactInvocationComponent) {
			component = context.lastComponent;
		}
		component ??= new CompactInvocationComponent();
		state.callComponent = component;
		component.setContent(prefix, `${affordance}${invocation}`);
		return component;
	};

	// Built-in renderers reuse `context.lastComponent` and call `setText`, so the expanded view needs its own slot.
	const renderExpanded = (
		context: ToolRenderContext<CompactRenderState, Record<string, any>>,
		render: (context: ToolRenderContext<CompactRenderState, Record<string, any>>) => Component,
	): Component => {
		const slot = (context.state.expanded ??= { state: {} });
		const component = render({
			...context,
			state: slot.state as CompactRenderState,
			lastComponent: slot.lastComponent,
		});
		slot.lastComponent = component;
		return component;
	};

	// The header line stays visible when expanded, so the row always shows what it is and that it is open.
	const composeExpanded = (
		context: ToolRenderContext<CompactRenderState, Record<string, any>>,
		theme: Theme,
		args: Record<string, any>,
		content: Component,
	): Component => {
		const container = context.lastComponent instanceof Container ? context.lastComponent : new Container();
		container.clear();
		container.addChild(updateCallText(args, theme, context, true));
		container.addChild(content);
		return container;
	};

	const hasExpandedView = (): boolean => {
		const expanded = options.expanded?.();
		return Boolean(expanded?.renderCall || expanded?.renderResult);
	};

	return {
		renderShell: "self",

		renderCall(args, theme, context) {
			const delegate = context.expanded ? options.expanded?.() : undefined;
			if (delegate?.renderCall) {
				const content = renderExpanded(context, (expandedContext) => delegate.renderCall!(args, theme, expandedContext));
				return composeExpanded(context, theme, args, content);
			}
			return updateCallText(args, theme, context, hasExpandedView());
		},

		renderResult(result, renderOptions, theme, context) {
			const delegate = context.expanded ? options.expanded?.() : undefined;
			if (delegate?.renderResult) {
				// The header belongs to the call slot, which pi renders above this one; adding it here
				// would print it twice.
				return renderExpanded(context, (expandedContext) =>
					delegate.renderResult!(result, renderOptions, theme, expandedContext),
				);
			}
			options.observeResult?.(result, renderOptions, context.state);
			updateCallText(context.args, theme, context, hasExpandedView());
			// Never reuse `lastComponent`: after a collapse it is still the expanded container, which
			// would leave the full built-in view on screen.
			return new EmptyComponent();
		},

		dispose() {
			if (rowTicker) clearInterval(rowTicker);
			rowTicker = undefined;
			rowInvalidators.clear();
		},
	};
}
