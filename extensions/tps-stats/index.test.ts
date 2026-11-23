import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";
import tpsStats from "./index.ts";

function setup(t: TestContext) {
	const handlers = new Map<string, (event: object, ctx: ExtensionContext) => void>();
	const statuses: (string | undefined)[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			setStatus(key: string, value: string | undefined) {
				assert.equal(key, "tps");
				statuses.push(value);
			},
		},
	} as ExtensionContext;
	tpsStats({ on: handlers.set.bind(handlers) } as unknown as ExtensionAPI);
	const emit = (type: string, event: object = {}) => handlers.get(type)!(event, ctx);
	const clock = t.mock.method(Date, "now", () => 0);
	emit("session_start");
	return {
		statuses,
		emit,
		start(timestamp: number) {
			emit("message_start", { message: { role: "assistant", timestamp } });
		},
		update<T extends Pick<MessageUpdateEvent["assistantMessageEvent"], "type">>(
			timestamp: number,
			elapsed: number,
			assistantMessageEvent: T,
		) {
			clock.mock.mockImplementation(() => timestamp + elapsed);
			emit("message_update", { message: { role: "assistant", timestamp }, assistantMessageEvent });
		},
		end(timestamp: number, durationMs: number | undefined, output: number, stopReason = "stop") {
			emit("message_end", { message: { role: "assistant", timestamp, durationMs, usage: { output }, stopReason } });
		},
	};
}

test("times the first nonempty delta, including reasoning and whitespace", (t) => {
	const stream = setup(t);
	stream.start(1000);
	stream.update(1000, 100, {
		type: "thinking_start", contentIndex: 0,
		partial: { content: [{ type: "thinking", thinking: " " }] },
	});
	stream.update(1000, 200, { type: "text_start" });
	stream.update(1000, 300, { type: "thinking_delta", delta: "" });
	stream.update(1000, 400, { type: "thinking_delta", delta: " " });
	stream.update(1000, 600, { type: "text_delta", delta: "answer" });
	stream.end(1000, 1400, 20);
	assert.deepEqual(stream.statuses, [undefined, "20t/s 0.4s"]);
});

test("counts a streamed tool name and ignores an ID-only tool call marker", (t) => {
	const stream = setup(t);
	stream.start(1000);
	stream.update(1000, 100, {
		type: "toolcall_start", contentIndex: 0,
		partial: { content: [{ type: "toolCall", id: "call_1", name: "" }] },
	});
	stream.update(1000, 500, {
		type: "toolcall_start", contentIndex: 1,
		partial: { content: [{ type: "toolCall", name: "" }, { type: "toolCall", name: "ls" }] },
	});
	stream.end(1000, 1500, 20, "toolUse");
	assert.deepEqual(stream.statuses, [undefined, "20t/s 0.5s"]);
});

test("averages only responses with usable decode windows", (t) => {
	const stream = setup(t);
	stream.start(1000);
	stream.update(1000, 200, { type: "toolcall_delta", delta: "{}" });
	stream.end(1000, 1200, 10);

	stream.start(3000);
	stream.update(3000, 100, { type: "text_start" });
	stream.update(3000, 200, { type: "text_delta", delta: "" });
	stream.update(3000, 900, { type: "text_end", content: "finished block" });
	stream.end(3000, 1000, 900);

	for (const [duration, elapsed, output, reason] of [
		[400, 400, 900, "stop"],
		[400, 500, 900, "stop"],
		[400, -100, 900, "stop"],
		[undefined, 200, 900, "stop"],
		[1000, 200, 0, "stop"],
		[1000, 200, 900, "aborted"],
		[1000, 200, 900, "error"],
	] as const) {
		stream.start(5000);
		stream.update(5000, elapsed, { type: "text_delta", delta: "answer" });
		stream.end(5000, duration, output, reason);
	}

	stream.start(7000);
	stream.update(7000, 1000, { type: "text_delta", delta: "answer" });
	stream.end(7000, 4000, 90);
	assert.deepEqual(stream.statuses, [undefined, "10t/s 0.2s", "25t/s 0.6s"]);
	stream.emit("session_shutdown");
	assert.equal(stream.statuses.at(-1), undefined);
});
