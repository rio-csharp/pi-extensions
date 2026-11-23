import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createCompactRenderer } from "./compact-tool-renderer.ts";

const theme = {
	fg: (color: string, text: string) => color === "error" ? `[error] ${text}` : text,
	bold: (text: string) => text,
} as Theme;

test("compact web rows reveal results and errors only when expanded", () => {
	const renderer = createCompactRenderer("web_fetch", () => "https://example.com/");
	const context: Parameters<typeof renderer.renderResult>[3] = {
		args: { url: "https://example.com/" },
		toolCallId: "test",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: ".",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
	};
	const render = (expanded: boolean) => {
		context.expanded = expanded;
		const result = renderer.renderResult({
			content: context.isError
				? [{ type: "text", text: "Request failed" }]
				: [{ type: "text", text: "Title\nBody" }, { type: "text", text: "More" }],
			details: undefined,
		}, { expanded, isPartial: false }, theme, context);
		context.lastComponent = result;
		return result.render(80).map((line) => line.trimEnd());
	};

	const header = renderer.renderCall(context.args, theme, context);
	assert.match(header.render(80).join("\n"), /web_fetch.*example\.com/);
	assert.deepEqual(render(false), []);
	assert.deepEqual(render(true), ["Title", "Body", "More"]);
	assert.deepEqual(render(false), []);

	context.isError = true;
	assert.deepEqual(render(true), ["[error] Request failed"]);
	assert.deepEqual(render(false), []);
});
