import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { countOutputLines } from "./built-in-tools.ts";
import compactToolUi from "./index.ts";
import {
	CompactInvocationComponent,	EXPAND_AFFORDANCE,	createCompactRenderer,
	type CompactRenderState,
} from "./compact-tool-renderer.ts";

function renderInvocation(invocation: string, width = 80, prefix = "P"): string[] {
	const component = new CompactInvocationComponent();
	component.setContent(prefix, invocation);
	return component.render(width);
}

test("shows naturally one-, two-, and three-line invocations without an ellipsis", () => {
	assert.deepEqual(renderInvocation("one"), ["P · one"]);
	assert.deepEqual(renderInvocation("one\ntwo"), ["P · one", "    two"]);
	assert.deepEqual(renderInvocation("one\ntwo\nthree"), ["P · one", "    two", "    three"]);
});

test("replaces the third display line with an aligned ellipsis only on overflow", () => {
	assert.deepEqual(renderInvocation("one\ntwo\nthree\nfour"), ["P · one", "    two", "    ..."]);
});

test("normalizes carriage returns and ignores only the final newline split artifact", () => {
	assert.deepEqual(renderInvocation("one\r\ntwo\rthree\r\nfour"), ["P · one", "    two", "    ..."]);
	assert.deepEqual(renderInvocation("one\ntwo\nthree\n"), ["P · one", "    two", "    three"]);
	assert.deepEqual(renderInvocation("one\n"), ["P · one"]);
	assert.deepEqual(renderInvocation("one\n\n"), ["P · one", "    "]);
});

test("preserves meaningful interior blank lines", () => {
	assert.deepEqual(renderInvocation("one\n\nthree"), ["P · one", "    ", "    three"]);
	assert.deepEqual(renderInvocation("one\n\nthree\nfour"), ["P · one", "    ", "    ..."]);
});

test("caps post-wrap display at narrow widths and never emits an over-wide line", () => {
	assert.deepEqual(renderInvocation("abcdefghijklmnopqrst", 8), ["P ·", "abcdefgh", "    ..."]);

	const ansiPrefix = "\x1b[31mP\x1b[0m";
	const ansiInvocation = "\x1b[32mabcdefghijklmnopqrst\x1b[0m";
	for (const width of [1, 2, 5, 8, 12]) {
		const lines = renderInvocation(ansiInvocation, width, ansiPrefix);
		assert(lines.length <= 3);
		assert(lines.every((line) => visibleWidth(line) <= width));
		assert(!lines.join("").includes("\r"));
	}

	const cached = new CompactInvocationComponent();
	cached.setContent("P", "short");
	assert.deepEqual(cached.render(80), ["P · short"]);
	cached.setContent("P", "one\ntwo\nthree\nfour");
	assert.deepEqual(cached.render(80), ["P · one", "    two", "    ..."]);
});

test("counts shell output lines without a trailing newline artifact", () => {
	assert.equal(countOutputLines(""), 0);
	assert.equal(countOutputLines("one"), 1);
	assert.equal(countOutputLines("one\n"), 1);
	assert.equal(countOutputLines("one\r\n"), 1);
	assert.equal(countOutputLines("one\rtwo\r"), 2);
	assert.equal(countOutputLines("one\n\n"), 2);
});

type RegisteredTool = {
	name: string;
	renderCall?: (args: Record<string, unknown>, theme: Theme, context: any) => unknown;
};

test("marks rows that can expand and keeps the header visible when they are open", () => {
	const full = { render: () => ["  file line 1", "  file line 2"], invalidate() {} };
	const renderer = createCompactRenderer("read", (args) => String(args.path), {
		expanded: () => ({ renderCall: () => full, renderResult: () => full }),
	});
	const context = (expanded: boolean, lastComponent?: unknown) => ({
		args: { path: "src/app.ts" },
		toolCallId: "call",
		invalidate() {},
		lastComponent,
		state: {} as CompactRenderState,
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: false,
		isError: false,
	});

	const collapsed = renderer.renderCall({ path: "src/app.ts" }, identityTheme, context(false) as never);
	const collapsedLines = collapsed.render(80);
	assert.equal(collapsedLines.length, 1);
	assert(collapsedLines[0].includes(` ${EXPAND_AFFORDANCE.collapsed} src/app.ts`));

	const expanded = renderer.renderCall({ path: "src/app.ts" }, identityTheme, context(true, collapsed) as never);
	const expandedLines = expanded.render(80);
	assert.equal(expandedLines.length, 3);
	assert(expandedLines[0].includes(` ${EXPAND_AFFORDANCE.expanded} src/app.ts`));
	assert.deepEqual(expandedLines.slice(1), ["  file line 1", "  file line 2"]);
});

test("shows no affordance when a row has nothing to expand", () => {
	const renderer = createCompactRenderer("read", (args) => String(args.path));
	const lines = renderer
		.renderCall({ path: "src/app.ts" }, identityTheme, callContext({ path: "src/app.ts" }) as never)
		.render(80);
	assert.equal(lines.length, 1);
	assert(!lines[0].includes(EXPAND_AFFORDANCE.collapsed));
});

test("collapses back to nothing and never repeats the header when expanded", () => {
	const full = { render: () => ["FULL-CONTENT"], invalidate() {} };
	const renderer = createCompactRenderer("read", (args) => String(args.path), {
		expanded: () => ({ renderCall: () => full, renderResult: () => full }),
	});
	const state = {} as CompactRenderState;
	const base = {
		args: { path: "src/app.ts" },
		toolCallId: "call",
		invalidate() {},
		state,
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		showImages: false,
		isError: false,
	};

	const expanded = renderer.renderResult({}, { isPartial: false }, identityTheme, {
		...base,
		expanded: true,
		lastComponent: undefined,
	} as never);
	assert.deepEqual(expanded.render(60), ["FULL-CONTENT"], "the result slot must not add its own header");

	const collapsed = renderer.renderResult({}, { isPartial: false }, identityTheme, {
		...base,
		expanded: false,
		lastComponent: expanded,
	} as never);
	assert.deepEqual(collapsed.render(60), [], "collapsing must clear the expanded view");
});

test("expanded delegates reuse only their own component and share row state", () => {
	const call = new Text("", 0, 0);
	const result = new Text("", 0, 0);
	let delegateState: CompactRenderState | undefined;
	let renders = 0;
	const base = callContext({ path: "src/app.ts" });
	const renderer = createCompactRenderer("read", (args) => String(args.path), {
		expanded: () => ({
			renderCall(_args, _theme, context) {
				assert.equal(context.lastComponent, renders === 0 ? undefined : call);
				assert.notEqual(context.state, base.state);
				delegateState ??= context.state;
				assert.equal(context.state, delegateState);
				call.setText(`CALL ${++renders}`);
				return call;
			},
			renderResult(_result, _options, _theme, context) {
				assert.equal(context.lastComponent, renders === 1 ? undefined : result);
				assert.equal(context.state, delegateState);
				result.setText(`RESULT ${renders}`);
				return result;
			},
		}),
	});
	const expandedCall = renderer.renderCall(base.args, identityTheme, { ...base, expanded: true });
	const expandedResult = renderer.renderResult({}, { isPartial: false }, identityTheme, { ...base, expanded: true });
	assert.deepEqual(expandedCall.render(80).slice(1).map((line) => line.trimEnd()), ["CALL 1"]);
	assert.deepEqual(expandedResult.render(80).map((line) => line.trimEnd()), ["RESULT 1"]);

	const collapsedCall = renderer.renderCall(base.args, identityTheme, { ...base, lastComponent: expandedCall });
	const collapsedResult = renderer.renderResult({}, { isPartial: false }, identityTheme, {
		...base,
		lastComponent: expandedResult,
	});
	assert.equal(collapsedCall.render(80).length, 1);
	assert.deepEqual(collapsedResult.render(80), []);

	const reopenedCall = renderer.renderCall(base.args, identityTheme, {
		...base,
		expanded: true,
		lastComponent: collapsedCall,
	});
	const reopenedResult = renderer.renderResult({}, { isPartial: false }, identityTheme, {
		...base,
		expanded: true,
		lastComponent: collapsedResult,
	});
	assert.deepEqual(reopenedCall.render(80).slice(1).map((line) => line.trimEnd()), ["CALL 2"]);
	assert.deepEqual(reopenedResult.render(80).map((line) => line.trimEnd()), ["RESULT 2"]);
});

const identityTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function callContext(args: Record<string, unknown>) {
	return {
		args,
		toolCallId: "call",
		invalidate() {},
		lastComponent: undefined,
		state: {} as CompactRenderState,
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
	};
}

test("all overridden built-in tools use the shared capped renderer without mutating arguments", () => {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		registerToolRenderer() {},
		registerMarkdownTransformer() {},
		on() {},
	} as unknown as ExtensionAPI;
	compactToolUi(pi);

	const invocations: Record<string, Record<string, unknown>> = {
		read: { path: "a/very/long/path/that/will/wrap/repeatedly/read.txt", offset: 2, limit: 20 },
		bash: { command: "first line\r\nsecond line\nthird line\nfourth line" },
		powershell: { command: "Write-Output 'first line'\r\nWrite-Output 'second line'" },
		edit: {
			path: "a/very/long/path/that/will/wrap/repeatedly/edit.ts",
			edits: [{ oldText: "old", newText: "new" }],
		},
		write: {
			path: "a/very/long/path/that/will/wrap/repeatedly/write.ts",
			content: "one\ntwo\nthree\nfour",
		},
		grep: {
			pattern: "a very long search pattern that wraps repeatedly",
			path: "a/very/long/path",
			glob: "**/*.ts",
		},
		find: { pattern: "**/a-very-long-pattern-that-wraps-repeatedly/*.ts", path: "a/very/long/path" },
		ls: { path: "a/very/long/path/that/will/wrap/repeatedly/listing", limit: 100 },
	};

	assert.deepEqual([...tools.keys()].sort(), Object.keys(invocations).sort());
	for (const [name, args] of Object.entries(invocations)) {
		const originalArgs = structuredClone(args);
		const tool = tools.get(name)!;
		assert(tool.renderCall);
		const component = tool.renderCall(args, identityTheme, callContext(args));
		assert(component instanceof CompactInvocationComponent, `${name} did not use the shared renderer`);
		const lines = component.render(16);
		assert(lines.length <= 3, `${name} rendered ${lines.length} lines`);
		assert(lines.every((line) => visibleWidth(line) <= 16), `${name} rendered an over-wide line`);
		assert.deepEqual(args, originalArgs, `${name} arguments were mutated while rendering`);
	}
});
