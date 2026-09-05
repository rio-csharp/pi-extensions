/**
 * relay-providers.ts — Static relay provider registration
 *
 * Loads the manually curated providers and models from
 * ~/.pi/agent/relay-providers.json. Providers or models with `hidden: true`
 * are kept in the config but not registered. Opening /model does not trigger
 * relay network requests or a second model-list update.
 *
 * Balance polling is owned by the separate relay-balance extension. Unknown
 * root/provider keys only produce warnings (never errors), so companion
 * extensions can share this config file.
 *
 * This file is the composition root: config.ts validates relay-providers.json
 * and streams.ts builds the pass-through/quota-retry streams.
 */

import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	isObject,
	normalizeQuotaRetry,
	type RelayConfig,
	type RelayModelConfig,
	validateRelayConfig,
	ZERO_COST,
} from "./config.ts";
import { createPassThroughStream, createQuotaRetryStream, createRetryStatusTracker } from "./streams.ts";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "relay-providers.json");
const OPENAI_BEARER_APIS = new Set(["openai-completions", "openai-responses"]);

function buildModel(model: RelayModelConfig, providerCompat?: Record<string, unknown>): ProviderModelConfig {
	const compat = providerCompat || model.compat
		? { ...providerCompat, ...model.compat }
		: undefined;
	return {
		id: model.id,
		name: model.name ?? model.id,
		api: model.api as never,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning ?? false,
		thinkingLevelMap: model.thinkingLevelMap,
		input: model.input ?? ["text"],
		cost: model.cost ?? ZERO_COST,
		contextWindow: model.contextWindow ?? 128000,
		maxTokens: model.maxTokens ?? 16384,
		headers: model.headers,
		compat: compat as never,
	};
}

function registerVisibleProviders(
	pi: ExtensionAPI,
	config: RelayConfig,
	statusTracker: ReturnType<typeof createRetryStatusTracker>,
): void {
	for (const provider of config.providers) {
		if (provider.hidden === true) continue;

		const visibleModels = provider.models.filter((model) => model.hidden !== true);
		// Do not register an empty provider when every configured model is hidden.
		if (visibleModels.length === 0) continue;

		const api = provider.api ?? "openai-completions";
		const quotaRetry = api === "openai-completions" ? normalizeQuotaRetry(provider.quotaRetry) : undefined;
		pi.registerProvider(provider.id, {
			name: provider.name ?? provider.id,
			baseUrl: provider.baseUrl,
			apiKey: provider.apiKey,
			api: api as never,
			// Preserve the OpenAI relay Bearer default without accidentally adding
			// it to Azure, Codex, Anthropic, Google, Bedrock, or other API families.
			authHeader: provider.authHeader ?? OPENAI_BEARER_APIS.has(api),
			headers: provider.headers,
			// Preserve the provider error body while redacting API-key-like tokens.
			streamSimple: (quotaRetry
				? createQuotaRetryStream(provider.name ?? provider.id, quotaRetry, statusTracker)
				: createPassThroughStream(api)) as never,
			models: visibleModels.map((model) => buildModel(model, provider.compat)),
		});
	}
}

function unregisterManagedProviders(pi: ExtensionAPI, config: RelayConfig): void {
	// Provider IDs are the ownership boundary in pi. Only unregister IDs that
	// are explicitly declared in relay-providers.json; built-in providers and
	// providers registered by other extensions under different IDs are untouched.
	for (const provider of config.providers) pi.unregisterProvider(provider.id);
}

export default async function (pi: ExtensionAPI) {
	let configText: string;
	try {
		configText = await readFile(CONFIG_PATH, "utf8");
	} catch (error) {
		const code = isObject(error) && typeof error.code === "string" ? ` (${error.code})` : "";
		console.error(`[relay-providers] Cannot read ${CONFIG_PATH}${code}; create or fix that local config file.`);
		return;
	}

	let rawConfig: unknown;
	try {
		rawConfig = JSON.parse(configText) as unknown;
	} catch {
		// Do not print JSON.parse's source excerpt: it could include an API key or
		// authorization header from the local file.
		console.error(`[relay-providers] Invalid JSON in ${CONFIG_PATH}; check its JSON syntax.`);
		return;
	}

	let config: RelayConfig;
	try {
		// Validate the entire shared local file, including hidden entries, before
		// the first registerProvider call mutates the provider runtime.
		const result = validateRelayConfig(rawConfig);
		config = result.config;
		// Unknown keys are warnings, not errors: companion extensions (e.g.
		// relay-balance) own extra fields in this shared file, and typos stay visible.
		for (const warning of result.warnings) console.warn(`[relay-providers] ${warning}`);
	} catch (error) {
		const reason = error instanceof Error ? error.message : "unknown validation error";
		console.error(`[relay-providers] Invalid ${CONFIG_PATH}:\n${reason}`);
		return;
	}

	let sessionContext: ExtensionContext | undefined;
	const retryStatusTracker = createRetryStatusTracker(() => sessionContext);
	registerVisibleProviders(pi, config, retryStatusTracker);

	pi.on("session_start", (_event, ctx) => {
		sessionContext = ctx;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		retryStatusTracker.clearAll();
		sessionContext = undefined;
		// ModelRuntime survives /reload and session replacement. The outgoing
		// extension instance owns cleanup; the new instance registers only once.
		unregisterManagedProviders(pi, config);
	});
}
