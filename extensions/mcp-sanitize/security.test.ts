import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import mcpSanitize, { sanitizeText } from "./index.ts";

const ESC = "\u001b";
const BEL = "\u0007";
const NUL = "\u0000";
const ZWSP = "\u200b";
const RLO = "\u202e";
const PDI = "\u202c";
const LRI = "\u2066";
const PDI2 = "\u2069";
const BOM = "\ufeff";

type ToolResultHandler = (event: any) => any;

function createHarness() {
	const handlers = new Map<string, ToolResultHandler>();
	const pi = {
		on(event: string, handler: ToolResultHandler) {
			handlers.set(event, handler);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	mcpSanitize(pi);
	const handler = handlers.get("tool_result");
	assert.ok(handler, "tool_result handler registered");
	return handler;
}

function mcpEvent(overrides: Record<string, unknown> = {}) {
	return {
		type: "tool_result",
		toolCallId: "call-1",
		toolName: "mcp__eudic__lookup",
		input: {},
		content: [{ type: "text", text: "clean" }],
		isError: false,
		...overrides,
	};
}

test("sanitizeText strips ANSI escape sequences and C0 controls", () => {
	assert.equal(sanitizeText(`${ESC}[31mred${ESC}[0m`), "red");
	assert.equal(sanitizeText(`bell${BEL}null${NUL}end`), "bellnullend");
});

test("sanitizeText strips zero-width and bidi override characters", () => {
	assert.equal(sanitizeText(`invis${ZWSP}ible`), "invisible");
	// Trojan Source: bidi override can reorder displayed text
	assert.equal(sanitizeText(`a${RLO}b${PDI}c`), "abc");
	assert.equal(sanitizeText(`${LRI}hidden${PDI2}`), "hidden");
});

test("sanitizeText strips BOM and keeps newlines, tabs, and unicode", () => {
	assert.equal(sanitizeText(`${BOM}line1\nline2\ttabbed café 中文`), "line1\nline2\ttabbed café 中文");
});

test("handler ignores non-MCP tools", () => {
	const handler = createHarness();
	assert.equal(handler(mcpEvent({ toolName: "bash" })), undefined);
	assert.equal(handler(mcpEvent({ toolName: "read" })), undefined);
});

test("handler sanitizes text content of MCP tools", () => {
	const handler = createHarness();
	const result = handler(
		mcpEvent({ content: [{ type: "text", text: `${ESC}[31m${ZWSP}evil${RLO}` }] }),
	);
	assert.equal(result.content[0].text, "evil");
});

test("handler covers MCP resource tools", () => {
	const handler = createHarness();
	for (const toolName of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) {
		const result = handler(mcpEvent({ toolName, content: [{ type: "text", text: `a${ZWSP}b` }] }));
		assert.equal(result.content[0].text, "ab", toolName);
	}
});

test("handler leaves image blocks untouched", () => {
	const handler = createHarness();
	const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
	const result = handler(mcpEvent({ content: [image] }));
	assert.deepEqual(result.content[0], image);
});

test("handler sanitizes structuredContent deeply and keeps it", () => {
	const handler = createHarness();
	const result = handler(
		mcpEvent({
			structuredContent: {
				content: [{ type: "text", text: `${ZWSP}zero-width` }],
				nested: { list: [`${RLO}bidi`, 42, null] },
			},
		}),
	);
	assert.deepEqual(result.structuredContent, {
		content: [{ type: "text", text: "zero-width" }],
		nested: { list: ["bidi", 42, null] },
	});
});

test("handler sanitizes error results too", () => {
	const handler = createHarness();
	const result = handler(
		mcpEvent({ isError: true, content: [{ type: "text", text: `fail${BEL}` }] }),
	);
	assert.equal(result.content[0].text, "fail");
});
