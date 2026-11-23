import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
	createAssistantMessageEventStream,
	normalizeContext,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Model,
} from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createQuotaRetryStream, createRetryStatusTracker } from "./streams.ts";

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test model",
	provider: "test-relay",
	api: "openai-completions",
	baseUrl: "https://relay.example/v1",
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1024,
	maxTokens: 128,
};

function message(timestamp: number, content: AssistantMessage["content"] = []): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content,
		stopReason: "stop",
		timestamp,
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { ...model.cost, total: 0 },
		},
	};
}

function failure(partial: AssistantMessage, errorMessage = "quota exceeded"): AssistantMessageEvent {
	return { type: "error", reason: "error", error: { ...partial, stopReason: "error", errorMessage } };
}

function streamOf(...events: AssistantMessageEvent[]) {
	const stream = createAssistantMessageEventStream();
	for (const event of events) stream.push(event);
	return stream;
}

function run(t: TestContext, ...attempts: ReturnType<typeof streamOf>[]) {
	let index = 0;
	const streamSimple = t.mock.method(getApiProvider(model.api)!, "streamSimple", () => {
		return attempts[index++] ?? streamOf(failure(message(0), "unexpected retry"));
	});
	const retry = createQuotaRetryStream("Test relay", {
		maxRetries: 1, baseDelayMs: 1, backoff: "fixed", matchAll: false, errorSubstrings: ["quota exceeded"],
	}, createRetryStatusTracker(() => undefined), model.api);
	return { stream: retry(model, normalizeContext({ messages: [] })), streamSimple };
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

test("quotaRetry discards a failed attempt's structural events and preserves the successful sequence", async (t) => {
	const failed = message(1);
	const emptyBlock = message(1, [{ type: "text", text: "" }]);
	const attempt = streamOf(
		{ type: "start", partial: failed },
		{ type: "text_start", contentIndex: 0, partial: emptyBlock },
		{ type: "text_delta", contentIndex: 0, delta: "", partial: emptyBlock },
		failure(emptyBlock),
	);
	const success = message(2, [{ type: "text", text: "hello" }]);
	const expected: AssistantMessageEvent[] = [
		{ type: "start", partial: message(2) },
		{ type: "text_start", contentIndex: 0, partial: message(2, [{ type: "text", text: "" }]) },
		{ type: "text_delta", contentIndex: 0, delta: "hello", partial: success },
		{ type: "text_end", contentIndex: 0, content: "hello", partial: success },
		{ type: "done", reason: "stop", message: success },
	];
	const { stream, streamSimple } = run(t, attempt, streamOf(...expected));
	assert.deepEqual(await collect(stream), expected);
	assert.equal(await stream.result(), success);
	assert.equal(streamSimple.mock.callCount(), 2);
});

test("quotaRetry flushes the start and real output immediately and forwards a later quota error", { timeout: 1_000 }, async (t) => {
	const partial = message(1, [{ type: "thinking", thinking: "reasoning" }]);
	const start: AssistantMessageEvent = { type: "start", partial: message(1) };
	const thinkingStart: AssistantMessageEvent = {
		type: "thinking_start", contentIndex: 0, partial: message(1, [{ type: "thinking", thinking: "" }]),
	};
	const delta: AssistantMessageEvent = { type: "thinking_delta", contentIndex: 0, delta: "reasoning", partial };
	const attempt = streamOf(start, thinkingStart, delta);
	const { stream, streamSimple } = run(t, attempt);
	const events = stream[Symbol.asyncIterator]();
	for (const value of [start, thinkingStart, delta]) {
		assert.deepEqual(await events.next(), { value, done: false });
	}
	const error = failure(partial);
	attempt.push(error);
	assert.deepEqual(await events.next(), { value: error, done: false });
	assert.equal((await events.next()).done, true);
	assert.equal(streamSimple.mock.callCount(), 1);
});

test("quotaRetry treats a named tool call as output even before its arguments arrive", async (t) => {
	const start: AssistantMessageEvent = { type: "start", partial: message(1) };
	const partial = message(1, [{ type: "toolCall", id: "call-1", name: "lookup", arguments: {} }]);
	const toolStart: AssistantMessageEvent = { type: "toolcall_start", contentIndex: 0, partial };
	const error = failure(partial);
	const { stream, streamSimple } = run(t, streamOf(start, toolStart, error));
	assert.deepEqual(await collect(stream), [start, toolStart, error]);
	assert.equal(streamSimple.mock.callCount(), 1);
});

test("quotaRetry preserves the final attempt's start when retries are exhausted", async (t) => {
	const first = message(1);
	const final = message(2);
	const start: AssistantMessageEvent = { type: "start", partial: final };
	const error = failure(final);
	const { stream, streamSimple } = run(t, streamOf({ type: "start", partial: first }, failure(first)), streamOf(start, error));
	assert.deepEqual(await collect(stream), [start, error]);
	assert.equal(streamSimple.mock.callCount(), 2);
});

test("quotaRetry forwards an empty success with its start event", async (t) => {
	const partial = message(1);
	const expected: AssistantMessageEvent[] = [
		{ type: "start", partial },
		{ type: "done", reason: "stop", message: partial },
	];
	const { stream, streamSimple } = run(t, streamOf(...expected));
	assert.deepEqual(await collect(stream), expected);
	assert.equal(streamSimple.mock.callCount(), 1);
});
