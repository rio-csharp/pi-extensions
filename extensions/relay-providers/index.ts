
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
		if (visibleModels.length === 0) continue;

		const api = provider.api ?? "openai-completions";
		const quotaRetry = api === "openai-completions" ? normalizeQuotaRetry(provider.quotaRetry) : undefined;
		pi.registerProvider(provider.id, {
			name: provider.name ?? provider.id,
			baseUrl: provider.baseUrl,
			apiKey: provider.apiKey,
			api: api as never,
			authHeader: provider.authHeader ?? OPENAI_BEARER_APIS.has(api),
			headers: provider.headers,
			streamSimple: (quotaRetry
				? createQuotaRetryStream(provider.name ?? provider.id, quotaRetry, statusTracker)
				: createPassThroughStream(api)) as never,
			models: visibleModels.map((model) => buildModel(model, provider.compat)),
		});
	}
}

function unregisterManagedProviders(pi: ExtensionAPI, config: RelayConfig): void {
	// Provider IDs are the ownership boundary: unregister only IDs declared in our config file.
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
		console.error(`[relay-providers] Invalid JSON in ${CONFIG_PATH}; check its JSON syntax.`);
		return;
	}

	let config: RelayConfig;
	try {
		const result = validateRelayConfig(rawConfig);
		config = result.config;
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
		unregisterManagedProviders(pi, config);
	});
}
