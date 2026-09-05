/**
 * Relay streaming: pass-through streams for every supported API family and the
 * opt-in, cancelable pre-output quota retry wrapper for openai-completions.
 * Provider error bodies are preserved while API-key-like tokens are redacted.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getApiProvider, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { type QuotaRetryOptions, ZERO_COST } from "./config.ts";
import { redactRelayErrorText } from "./sanitize.ts";

const MAX_RETRY_DELAY_MS = 60_000;
const RETRY_STATUS_PREFIX = "relay-quota-retry";

export type OpenAICompletionsStream = (
	model: Model<"openai-completions">,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export function isConfiguredRetryError(message: string | undefined, retry: QuotaRetryOptions): boolean {
	if (retry.matchAll) return true;
	if (!message) return false;
	const normalized = message.toLocaleLowerCase();
	return retry.errorSubstrings.some((substring) => normalized.includes(substring.toLocaleLowerCase()));
}

function passThroughRelayError(message: AssistantMessage): AssistantMessage {
	if (!message.errorMessage) return message;
	const errorMessage = redactRelayErrorText(message.errorMessage);
	return errorMessage === message.errorMessage ? message : { ...message, errorMessage };
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);

	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		}, delayMs);

		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(false);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function makeAbortedMessage(
	model: Model<"openai-completions">,
	previous?: AssistantMessage,
): AssistantMessage {
	if (previous) {
		return { ...previous, stopReason: "aborted", errorMessage: "Request was aborted" };
	}
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { ...ZERO_COST, total: 0 },
		},
		stopReason: "aborted",
		errorMessage: "Request was aborted",
		timestamp: Date.now(),
	};
}

interface RetryStatusHandle {
	set(message: string): void;
	clear(): void;
}

export interface RetryStatusTracker {
	createHandle(): RetryStatusHandle;
	clearAll(): void;
}

export function createRetryStatusTracker(getSessionContext: () => ExtensionContext | undefined): RetryStatusTracker {
	let nextRequestId = 0;
	const activeStatusIds = new Set<string>();
	return {
		createHandle() {
			const statusId = `${RETRY_STATUS_PREFIX}-${++nextRequestId}`;
			return {
				set(message) {
					const sessionContext = getSessionContext();
					if (!sessionContext?.hasUI) return;
					activeStatusIds.add(statusId);
					sessionContext.ui.setStatus(statusId, message);
				},
				clear() {
					if (!activeStatusIds.delete(statusId)) return;
					getSessionContext()?.ui.setStatus(statusId, undefined);
				},
			};
		},
		clearAll() {
			const sessionContext = getSessionContext();
			for (const statusId of activeStatusIds) sessionContext?.ui.setStatus(statusId, undefined);
			activeStatusIds.clear();
		},
	};
}

export function createQuotaRetryStream(
	providerLabel: string,
	retry: QuotaRetryOptions,
	statusTracker: RetryStatusTracker,
): OpenAICompletionsStream {
	const completions = openAICompletionsApi();

	return (model, context, options) => {
		const output = createAssistantMessageEventStream();
		const status = statusTracker.createHandle();
		let lastError: AssistantMessage | undefined;

		void (async () => {
			let attempt = 0;

			while (true) {
				if (options?.signal?.aborted) {
					status.clear();
					output.push({ type: "error", reason: "aborted", error: makeAbortedMessage(model, lastError) });
					output.end();
					return;
				}

				const current = completions.streamSimple(model, context, options);
				let emitted = false;
				let requestError: AssistantMessage | undefined;

				for await (const event of current) {
					if (event.type === "error") {
						requestError = event.error;
						continue;
					}

					// OpenAI Completions emits `start` only after the HTTP request succeeds.
					// Never retry after that point, because output might otherwise be duplicated.
					emitted = true;
					status.clear();
					output.push(event);
				}

				if (!requestError) {
					status.clear();
					output.end();
					return;
				}

				const shouldRetry =
					!emitted &&
					!options?.signal?.aborted &&
					requestError.stopReason === "error" &&
					isConfiguredRetryError(requestError.errorMessage, retry) &&
					attempt < retry.maxRetries;
				const rawRequestError = passThroughRelayError(requestError);
				lastError = rawRequestError;

				if (!shouldRetry) {
					status.clear();
					const aborted = options?.signal?.aborted || rawRequestError.stopReason === "aborted";
					output.push({
						type: "error",
						reason: aborted ? "aborted" : "error",
						error: aborted ? makeAbortedMessage(model, rawRequestError) : rawRequestError,
					});
					output.end();
					return;
				}

				attempt += 1;
				const delayMs =
					retry.backoff === "fixed"
						? retry.baseDelayMs
						: Math.min(MAX_RETRY_DELAY_MS, retry.baseDelayMs * 2 ** (attempt - 1));
				status.set(
					`${providerLabel} configured retry · ${attempt}/${retry.maxRetries} in ${delayMs / 1000}s · Esc cancels`,
				);
				if (!(await waitForRetry(delayMs, options?.signal))) {
					status.clear();
					output.push({ type: "error", reason: "aborted", error: makeAbortedMessage(model, rawRequestError) });
					output.end();
					return;
				}
			}
		})().catch(() => {
			status.clear();
			const message = makeAbortedMessage(model, lastError);
			message.stopReason = options?.signal?.aborted ? "aborted" : "error";
			message.errorMessage = options?.signal?.aborted
				? "Request was aborted"
				: "Relay request failed before a response was produced";
			output.push({ type: "error", reason: message.stopReason, error: message });
			output.end();
		});

		return output;
	};
}

export function createPassThroughStream(api: string): OpenAICompletionsStream {
	return (model, context, options) => {
		const output = createAssistantMessageEventStream();
		void (async () => {
			const implementation = getApiProvider(api);
			if (!implementation) throw new Error("unsupported API implementation");
			for await (const event of implementation.streamSimple(model, context, options)) {
				if (event.type === "error") {
					const rawError = passThroughRelayError(event.error);
					output.push({
						type: "error",
						reason: rawError.stopReason === "aborted" ? "aborted" : "error",
						error: rawError,
					});
					continue;
				}
				output.push(event);
			}
			output.end();
		})().catch(() => {
			const aborted = options?.signal?.aborted === true;
			const message = makeAbortedMessage(model);
			message.stopReason = aborted ? "aborted" : "error";
			message.errorMessage = aborted
				? "Request was aborted"
				: "Relay request failed before a response was produced";
			output.push({ type: "error", reason: message.stopReason, error: message });
			output.end();
		});
		return output;
	};
}
