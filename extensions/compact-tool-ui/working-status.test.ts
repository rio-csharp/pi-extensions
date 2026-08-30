import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerWorkingStatus } from "./working-status.ts";

type Handler = (event: any, ctx: ExtensionContext) => void;

function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const messages: Array<string | undefined> = [];
	const visibility: boolean[] = [];
	const pi = {
		on(event: string, handler: Handler) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		ui: {
			setWorkingMessage(message?: string) {
				messages.push(message);
			},
			setWorkingVisible(visible: boolean) {
				visibility.push(visible);
			},
		},
	} as unknown as ExtensionContext;

	registerWorkingStatus(pi);

	return {
		messages,
		visibility,
		emit(event: string, payload: Record<string, unknown> = {}) {
			for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
		},
	};
}

function assertStage(message: string | undefined, stage: string): void {
	assert(message?.startsWith(`${stage} · `), `Expected stage ${stage}, received ${message}`);
}

test("tracks context, provider, stream, and tool stages", () => {
	const harness = createHarness();

	try {
		harness.emit("agent_start");
		assertStage(harness.messages.at(-1), "Preparing model request");

		harness.emit("context");
		assertStage(harness.messages.at(-1), "Preparing conversation context");

		harness.emit("before_provider_request");
		assertStage(harness.messages.at(-1), "Requesting model");

		harness.emit("after_provider_response");
		assertStage(harness.messages.at(-1), "Receiving model response");

		harness.emit("message_update", {
			message: { role: "assistant", content: [] },
			assistantMessageEvent: { type: "thinking_delta" },
		});
		assertStage(harness.messages.at(-1), "Generating reasoning");

		harness.emit("message_update", {
			message: { role: "assistant", content: [] },
			assistantMessageEvent: { type: "text_delta" },
		});
		assertStage(harness.messages.at(-1), "Generating response");

		harness.emit("message_update", {
			message: {
				role: "assistant",
				content: [{ type: "toolCall", name: "read" }],
			},
			assistantMessageEvent: { type: "toolcall_delta" },
		});
		assertStage(harness.messages.at(-1), "Preparing tool call: read");

		harness.emit("tool_execution_start", { toolCallId: "call-1" });
		assert.equal(harness.visibility.at(-1), false);

		harness.emit("tool_execution_end", { toolCallId: "call-1" });
		assert.equal(harness.visibility.at(-1), true);
		assertStage(harness.messages.at(-1), "Tool completed; waiting for model");

		harness.emit("agent_end");
		assert.equal(harness.messages.at(-1), undefined);
	} finally {
		harness.emit("session_shutdown");
	}
});
