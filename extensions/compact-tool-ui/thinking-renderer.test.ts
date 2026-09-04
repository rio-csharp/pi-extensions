import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerThinkingRenderer } from "./thinking-renderer.ts";

type MarkdownTransformer = (
	markdown: string,
	context: {
		messageType: string;
		isStreaming: boolean;
		availableWidth: number;
	},
) => string;

function getTransformer(): MarkdownTransformer {
	let transformer: MarkdownTransformer | undefined;
	const pi = {
		registerMarkdownTransformer(value: MarkdownTransformer) {
			transformer = value;
		},
	} as unknown as ExtensionAPI;

	registerThinkingRenderer(pi);
	assert(transformer, "thinking renderer did not register a transformer");
	return transformer;
}

test("keeps only the latest thinking line", () => {
	const transform = getTransformer();
	assert.equal(
		transform("first thought\n\nsecond thought\nthird thought", {
			messageType: "assistant-thinking",
			isStreaming: true,
			availableWidth: 80,
		}),
		"third thought",
	);
});

test("keeps the final thinking line after streaming ends", () => {
	const transform = getTransformer();
	assert.equal(
		transform("first thought\nsecond thought", {
			messageType: "assistant-thinking",
			isStreaming: false,
			availableWidth: 80,
		}),
		"second thought",
	);
});

test("leaves non-thinking Markdown unchanged", () => {
	const transform = getTransformer();
	assert.equal(
		transform("first\nsecond", {
			messageType: "assistant",
			isStreaming: true,
			availableWidth: 80,
		}),
		"first\nsecond",
	);
});
