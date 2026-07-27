/**
 * relay-providers.ts — Static relay provider registration
 *
 * Loads the manually curated providers and models from
 * ~/.pi/agent/relay-providers.json. Providers or models with `hidden: true`
 * are kept in the config but not registered. Opening /model does not trigger
 * relay network requests or a second model-list update.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "relay-providers.json");
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

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

function registerVisibleProviders(pi: ExtensionAPI, config: RelayConfig): void {
	for (const provider of config.providers) {
		if (provider.hidden === true) continue;

		const visibleModels = provider.models.filter((model) => model.hidden !== true);
		// Do not register an empty provider when every configured model is hidden.
		if (visibleModels.length === 0) continue;

		pi.registerProvider(provider.id, {
			name: provider.name ?? provider.id,
			baseUrl: provider.baseUrl,
			apiKey: provider.apiKey,
			api: (provider.api ?? "openai-completions") as never,
			authHeader: true,
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
	try {
		config = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as RelayConfig;
	} catch (error) {
		console.error(`[relay-providers] Failed to read ${CONFIG_PATH}:`, error);
		return;
	}

	registerVisibleProviders(pi, config);

	pi.on("session_shutdown", () => {
		// ModelRuntime survives /reload and session replacement. Explicitly
		// remove every provider owned by this extension so hidden/removed entries
		// cannot remain in memory from the previous extension instance.
		unregisterManagedProviders(pi, config);
	});

	pi.on("session_start", (event) => {
		if (event.reason !== "reload") return;

		// Compatibility cleanup for the first reload from older versions of this
		// extension, which did not unregister providers during session_shutdown.
		// Re-registering after cleanup also guarantees that the models array is
		// replaced rather than merged with the previous registration.
		unregisterManagedProviders(pi, config);
		registerVisibleProviders(pi, config);
	});
}
