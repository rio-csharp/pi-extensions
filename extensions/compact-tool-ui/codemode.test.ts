import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { formatCodemodeInvocation, registerCompactCodemode } from "./codemode.ts";
import { CompactInvocationComponent, type CompactRenderState } from "./compact-tool-renderer.ts";

const identityTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

test("summarizes the script's first meaningful line with a line count", () => {
	assert.equal(formatCodemodeInvocation({ code: "const a = 1;\nreturn a;" }, identityTheme), "const a = 1; · 2 lines");
	assert.equal(formatCodemodeInvocation({ code: "\n\n  return 1;  " }, identityTheme), "return 1;");
	assert.equal(formatCodemodeInvocation({ code: "// @options: {\"maxCalls\":5}\nreturn 1;" }, identityTheme), "{\"maxCalls\":5} · 2 lines");
	assert.equal(formatCodemodeInvocation({ code: "single" }, identityTheme), "single");
});

test("summarizes empty and oversized scripts without breaking the row", () => {
	assert.equal(formatCodemodeInvocation({}, identityTheme), "...");
	assert.equal(formatCodemodeInvocation({ code: "   \n  " }, identityTheme), "...");

	const long = `const value = "${"x".repeat(200)}";`;
	const summary = formatCodemodeInvocation({ code: long }, identityTheme);
	assert.equal(summary.length, 103);
	assert(summary.endsWith("..."));
});

type Renderers = {
	renderShell?: "default" | "self";
	renderCall?: (args: Record<string, unknown>, theme: Theme, context: any) => any;
	renderResult?: (...args: any[]) => any;
};

class StubText {
	text = "";

	setText(value: string): void {
		this.text = value;
	}

	render(): string[] {
		return [this.text];
	}
}

function renderContext(options: { expanded: boolean; lastComponent?: unknown }): any {
	return {
		args: { code: "return 1;" },
		toolCallId: "call",
		invalidate() {},
		lastComponent: options.lastComponent,
		state: {} as CompactRenderState,
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: options.expanded,
		showImages: false,
		isError: false,
	};
}

function registerCodemodeResolver() {
	let resolver: ((toolName: string, next: () => Renderers | undefined) => Renderers | undefined) | undefined;
	const pi = {
		registerToolRenderer(value: typeof resolver) {
			resolver = value;
		},
		on() {},
	} as unknown as ExtensionAPI;
	registerCompactCodemode(pi);
	assert(resolver);
	return resolver;
}

test("leaves every other tool's renderers untouched", () => {
	const resolve = registerCodemodeResolver();
	const base: Renderers = { renderCall: () => new StubText() };
	assert.equal(resolve("read", () => base), base);
	assert.equal(resolve("subagent", () => base), base);
});

test("expands to the runtime's own codemode renderers with an isolated component slot", () => {
	const resolve = registerCodemodeResolver();
	let received: unknown;
	const base: Renderers = {
		renderCall(_args, _theme, context) {
			received = context.lastComponent;
			const text = context.lastComponent ?? new StubText();
			text.setText("full script");
			return text;
		},
	};

	const renderers = resolve("codemode", () => base);
	assert(renderers?.renderCall);

	const collapsedComponent = renderers.renderCall({ code: "return 1;" }, identityTheme, renderContext({ expanded: false }));
	assert(collapsedComponent instanceof CompactInvocationComponent);

	const expandedComponent = renderers.renderCall(
		{ code: "return 1;" },
		identityTheme,
		renderContext({ expanded: true, lastComponent: collapsedComponent }),
	);
	assert(!(expandedComponent instanceof CompactInvocationComponent));
	assert.equal(received, undefined);
	const lines = expandedComponent.render(80);
	assert(lines[0].includes("▾"), `expanded header lost its affordance: ${JSON.stringify(lines[0])}`);
	assert.equal(lines.at(-1), "full script");
});

test("falls back to the compact row when expanded without a built-in renderer", () => {
	const resolve = registerCodemodeResolver();
	const renderers = resolve("codemode", () => undefined);
	assert(renderers?.renderCall);

	const component = renderers.renderCall({ code: "return 1;" }, identityTheme, renderContext({ expanded: true }));
	assert(component instanceof CompactInvocationComponent);
});
