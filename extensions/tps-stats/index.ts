import type { ExtensionAPI, ExtensionContext, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "tps";

function hasStreamContent(event: MessageUpdateEvent["assistantMessageEvent"]): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		case "toolcall_start": {
			// The generated name counts, including for calls that never stream arguments.
			const block = event.partial.content[event.contentIndex];
			return block?.type === "toolCall" && block.name.length > 0;
		}
		default:
			// Text/thinking starts are markers and their live partials can already contain later deltas.
			return false;
	}
}

// Both averages use the same set of responses. TPS divides total tokens by total decode time.
let outputTokens = 0;
let decodeMs = 0;
let ttftMs = 0;
let samples = 0;

/** The assistant response currently streaming, keyed by the provider-reported request start. */
let current: { requestStartedAt: number; ttftMs?: number } | undefined;

function reset(): void {
	outputTokens = 0;
	decodeMs = 0;
	ttftMs = 0;
	samples = 0;
	current = undefined;
}

function formatRate(rate: number): string {
	if (!Number.isFinite(rate) || rate <= 0) return "0";
	return rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1);
}

function formatSeconds(ms: number): string {
	const seconds = ms / 1000;
	return seconds >= 10 ? String(Math.round(seconds)) : Math.max(0.1, seconds).toFixed(1);
}

function statusText(): string | undefined {
	if (samples === 0) return undefined;
	return `${formatRate((outputTokens / decodeMs) * 1000)}t/s ${formatSeconds(ttftMs / samples)}s`;
}

function publish(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, statusText());
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		reset();
		publish(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		reset();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("message_start", event => {
		// `timestamp` is set by the provider just before it sends the request, so it excludes pi's local
		// preparation and measures request to first output. Only assistant messages carry a stream.
		if (event.message.role !== "assistant") return;
		current = { requestStartedAt: event.message.timestamp };
	});

	pi.on("message_update", event => {
		const entry = current;
		if (!entry || entry.ttftMs !== undefined) return;
		if (event.message.role !== "assistant" || entry.requestStartedAt !== event.message.timestamp) return;
		if (!hasStreamContent(event.assistantMessageEvent)) return;
		entry.ttftMs = Date.now() - entry.requestStartedAt;
	});

	pi.on("message_end", (event, ctx) => {
		// Observation only: never return a replacement message.
		if (event.message.role !== "assistant") return;
		const message = event.message;
		const entry = current && current.requestStartedAt === message.timestamp ? current : undefined;
		current = undefined;
		if (message.stopReason === "aborted" || message.stopReason === "error") return;
		const output = message.usage?.output;
		// `durationMs` is a monotonic request-to-done measurement that only the streaming providers set.
		const totalMs = message.durationMs;
		if (typeof output !== "number" || typeof totalMs !== "number") return;
		if (!Number.isFinite(output) || output <= 0 || !Number.isFinite(totalMs) || totalMs <= 0) return;
		const measuredTtft = entry?.ttftMs;
		if (measuredTtft === undefined || !Number.isFinite(measuredTtft) || measuredTtft <= 0 || measuredTtft >= totalMs) return;
		outputTokens += output;
		decodeMs += totalMs - measuredTtft;
		ttftMs += measuredTtft;
		samples += 1;
		publish(ctx);
	});
}
