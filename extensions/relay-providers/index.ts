/**
 * relay-providers.ts — Static relay provider registration
 *
 * Loads the manually curated providers and models from
 * ~/.pi/agent/relay-providers.json. Providers or models with `hidden: true`
 * are kept in the config but not registered. Opening /model does not trigger
 * relay network requests or a second model-list update.
 */

import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "relay-providers.json");
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const SENSENOVA_PROVIDER_ID = "sensenova";
const SENSENOVA_MAX_QUOTA_RETRIES = 3;
const SENSENOVA_RETRY_BASE_DELAY_MS = 2_000;
const SENSENOVA_STATUS_ID = "sensenova-quota-retry";

type OpenAICompletionsStream = (
	model: Model<"openai-completions">,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

function isSenseNovaTransientQuotaError(message: string | undefined): boolean {
	if (!message) return false;
	return (
		/insufficient_quota/i.test(message) ||
		/you exceeded your current quota/i.test(message)
	);
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

function createSenseNovaQuotaRetryStream(
	getSessionContext: () => ExtensionContext | undefined,
	onRetry: (attempt: number) => void,
): OpenAICompletionsStream {
	const completions = openAICompletionsApi();
	const clearStatus = () => getSessionContext()?.ui.setStatus(SENSENOVA_STATUS_ID, undefined);

	return (model, context, options) => {
		const output = createAssistantMessageEventStream();

		void (async () => {
			let attempt = 0;
			let lastError: AssistantMessage | undefined;

			while (true) {
				if (options?.signal?.aborted) {
					clearStatus();
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
					clearStatus();
					output.push(event);
				}

				if (!requestError) {
					clearStatus();
					output.end();
					return;
				}

				lastError = requestError;
				const shouldRetry =
					!emitted &&
					!options?.signal?.aborted &&
					requestError.stopReason === "error" &&
					isSenseNovaTransientQuotaError(requestError.errorMessage) &&
					attempt < SENSENOVA_MAX_QUOTA_RETRIES;

				if (!shouldRetry) {
					clearStatus();
					output.push({
						type: "error",
						reason: options?.signal?.aborted ? "aborted" : "error",
						error: options?.signal?.aborted ? makeAbortedMessage(model, requestError) : requestError,
					});
					output.end();
					return;
				}

				attempt += 1;
				onRetry(attempt);
				const delayMs = SENSENOVA_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
				const sessionContext = getSessionContext();
				if (sessionContext?.hasUI) {
					sessionContext.ui.setStatus(
						SENSENOVA_STATUS_ID,
						`SenseNova quota 429 · retry ${attempt}/${SENSENOVA_MAX_QUOTA_RETRIES} in ${delayMs / 1000}s · Esc cancels`,
					);
				}
				if (!(await waitForRetry(delayMs, options?.signal))) {
					clearStatus();
					output.push({ type: "error", reason: "aborted", error: makeAbortedMessage(model, requestError) });
					output.end();
					return;
				}
			}
		})().catch((error) => {
			clearStatus();
			const message = makeAbortedMessage(model, lastError);
			message.stopReason = options?.signal?.aborted ? "aborted" : "error";
			message.errorMessage = error instanceof Error ? error.message : String(error);
			output.push({ type: "error", reason: message.stopReason, error: message });
			output.end();
		});

		return output;
	};
}

interface RelayModelConfig {
	id: string;
	/** Keep this model in the config without registering it. Default: false. */
	hidden?: boolean;
	api?: string;
	name?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
}

interface RelayProviderConfig {
	id: string;
	/** Keep this provider and all its models in the config without registering them. Default: false. */
	hidden?: boolean;
	name?: string;
	baseUrl: string;
	apiKey: string;
	api?: string;
	models: RelayModelConfig[];
}

interface RelayConfig {
	providers: RelayProviderConfig[];
}

function buildModel(model: RelayModelConfig): ProviderModelConfig {
	return {
		id: model.id,
		name: model.name ?? model.id,
		api: model.api as never,
		reasoning: model.reasoning ?? false,
		thinkingLevelMap: model.thinkingLevelMap,
		input: model.input ?? ["text"],
		cost: model.cost ?? ZERO_COST,
		contextWindow: model.contextWindow ?? 128000,
		maxTokens: model.maxTokens ?? 16384,
		headers: model.headers,
		compat: model.compat as never,
	};
}

function registerVisibleProviders(
	pi: ExtensionAPI,
	config: RelayConfig,
	senseNovaQuotaRetryStream: OpenAICompletionsStream,
): void {
	for (const provider of config.providers) {
		if (provider.hidden === true) continue;

		const visibleModels = provider.models.filter((model) => model.hidden !== true);
		// Do not register an empty provider when every configured model is hidden.
		if (visibleModels.length === 0) continue;

		const api = provider.api ?? "openai-completions";
		pi.registerProvider(provider.id, {
			name: provider.name ?? provider.id,
			baseUrl: provider.baseUrl,
			apiKey: provider.apiKey,
			api: api as never,
			authHeader: true,
			streamSimple:
				provider.id === SENSENOVA_PROVIDER_ID && api === "openai-completions"
					? senseNovaQuotaRetryStream
					: undefined,
			models: visibleModels.map(buildModel),
		});
	}
}

function unregisterManagedProviders(pi: ExtensionAPI, config: RelayConfig): void {
	// Provider IDs are the ownership boundary in pi. Only unregister IDs that
	// are explicitly declared in relay-providers.json; built-in providers and
	// providers registered by other extensions under different IDs are untouched.
	for (const provider of config.providers) {
		pi.unregisterProvider(provider.id);
	}
}

export default async function (pi: ExtensionAPI) {
	let config: RelayConfig;
	let sessionContext: ExtensionContext | undefined;
	let lastSenseNovaRetryCount = 0;
	try {
		config = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as RelayConfig;
	} catch (error) {
		console.error(`[relay-providers] Failed to read ${CONFIG_PATH}:`, error);
		return;
	}

	const senseNovaQuotaRetryStream = createSenseNovaQuotaRetryStream(
		() => sessionContext,
		(attempt) => {
			lastSenseNovaRetryCount = attempt;
		},
	);

	registerVisibleProviders(pi, config, senseNovaQuotaRetryStream);

	pi.on("session_shutdown", () => {
		sessionContext?.ui.setStatus(SENSENOVA_STATUS_ID, undefined);
		sessionContext = undefined;
		// ModelRuntime survives /reload and session replacement. Explicitly
		// remove every provider owned by this extension so hidden/removed entries
		// cannot remain in memory from the previous extension instance.
		unregisterManagedProviders(pi, config);
	});

	pi.on("session_start", (event, ctx) => {
		sessionContext = ctx;
		lastSenseNovaRetryCount = 0;
		if (event.reason !== "reload") return;

		// Compatibility cleanup for the first reload from older versions of this
		// extension, which did not unregister providers during session_shutdown.
		// Re-registering after cleanup also guarantees that the models array is
		// replaced rather than merged with the previous registration.
		unregisterManagedProviders(pi, config);
		registerVisibleProviders(pi, config, senseNovaQuotaRetryStream);
	});

	pi.registerCommand("sensenova-retry-status", {
		description: "Show the SenseNova quota-429 retry configuration",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`${SENSENOVA_PROVIDER_ID}\ninsufficient_quota: up to ${SENSENOVA_MAX_QUOTA_RETRIES} retries (2s, 4s, 8s; Esc cancels)\nLast request retry count: ${lastSenseNovaRetryCount}`,
				"info",
			);
		},
	});
}
