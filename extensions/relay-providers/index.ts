
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
const MODELS_STORE_PATH = join(AGENT_DIR, "models-store.json");
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
		const quotaRetry = normalizeQuotaRetry(provider.quotaRetry);
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

async function readModelsStore(): Promise<Record<string, unknown> | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(MODELS_STORE_PATH, "utf8"));
		return isObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Hide unlisted built-in catalog models by re-registering the provider with only the
 * kept models (full definitions copied from the models-store.json catalog cache).
 * Auth, streaming, and catalog refresh stay with the built-in provider layer;
 * unregistering later simply restores the full built-in model list.
 * Returns the provider IDs that were filtered.
 */
function registerCatalogFilters(
	pi: ExtensionAPI,
	config: RelayConfig,
	store: Record<string, unknown> | undefined,
): string[] {
	const filters = config.catalogFilters ?? {};
	const filtered: string[] = [];
	for (const [providerId, keepIds] of Object.entries(filters)) {
		const entry = store?.[providerId];
		const storeModels = isObject(entry) && Array.isArray(entry.models) ? entry.models : undefined;
		if (!storeModels) {
			console.warn(`[relay-providers] catalogFilters: no cached catalog data for "${providerId}" in models-store.json; skipping filter (run \`pi update --models\` to refresh the cache)`);
			continue;
		}
		const defs: ProviderModelConfig[] = [];
		for (const keepId of keepIds) {
			const def = storeModels.find((model) => isObject(model) && model.id === keepId);
			if (def) defs.push(def as unknown as ProviderModelConfig);
			else console.warn(`[relay-providers] catalogFilters: model "${keepId}" not found in the cached catalog for "${providerId}"; skipped`);
		}
		if (defs.length === 0) {
			console.warn(`[relay-providers] catalogFilters: no models resolved for "${providerId}"; provider left untouched`);
			continue;
		}
		pi.registerProvider(providerId, { models: defs });
		filtered.push(providerId);
	}
	return filtered;
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
	const store = config.catalogFilters ? await readModelsStore() : undefined;
	const filteredProviderIds = registerCatalogFilters(pi, config, store);

	pi.on("session_start", (_event, ctx) => {
		sessionContext = ctx;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		retryStatusTracker.clearAll();
		sessionContext = undefined;
		unregisterManagedProviders(pi, config);
		// Restores the full built-in model lists (unregister only drops our extension layer).
		for (const providerId of filteredProviderIds) pi.unregisterProvider(providerId);
	});
}
