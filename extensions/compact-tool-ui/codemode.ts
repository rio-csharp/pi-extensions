import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { countOutputLines, getTextResult } from "./built-in-tools.ts";
import { createCompactRenderer, type ExpandedRenderers } from "./compact-tool-renderer.ts";

const CODEMODE_TOOL_NAME = "codemode";
const MAX_INVOCATION_CHARS = 100;
const OPTIONS_PREFIX = "// @options:";

function summarize(line: string): string {
	const text = line.startsWith(OPTIONS_PREFIX) ? line.slice(OPTIONS_PREFIX.length).trim() : line;
	return text.length > MAX_INVOCATION_CHARS ? `${text.slice(0, MAX_INVOCATION_CHARS)}...` : text;
}

export function formatCodemodeInvocation(args: Record<string, any>, theme: Theme): string {
	const raw = typeof args?.code === "string" ? args.code.replace(/\r\n?/g, "\n") : "";
	const lines = raw.split("\n");
	while (lines.length > 0 && !lines[0]!.trim()) lines.shift();
	while (lines.length > 0 && !lines[lines.length - 1]!.trim()) lines.pop();
	const firstLine = lines[0]?.trim();
	if (!firstLine) return "...";
	const suffix = lines.length > 1 ? theme.fg("dim", ` · ${lines.length} lines`) : "";
	return `${summarize(firstLine)}${suffix}`;
}

export function registerCompactCodemode(pi: ExtensionAPI): void {
	let expanded: ExpandedRenderers | undefined;

	const renderer = createCompactRenderer(CODEMODE_TOOL_NAME, formatCodemodeInvocation, {
		observeResult(result, options, state) {
			if (options.isPartial) state.outputLines = countOutputLines(getTextResult(result));
		},
		expanded: () => expanded,
	});

	pi.registerToolRenderer((toolName, next) => {
		if (toolName !== CODEMODE_TOOL_NAME) return next();
		const base = next();
		expanded = {
			renderCall: base?.renderCall as ExpandedRenderers["renderCall"],
			renderResult: base?.renderResult as ExpandedRenderers["renderResult"],
		};
		return {
			renderShell: renderer.renderShell,
			renderCall: renderer.renderCall as never,
			renderResult: renderer.renderResult as never,
		};
	});

	pi.on("session_shutdown", () => renderer.dispose());
}
