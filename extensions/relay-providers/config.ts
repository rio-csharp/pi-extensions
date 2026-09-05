/**
 * Configuration types and strict validation for relay-providers.json.
 *
 * This is a trusted, user-local configuration. API keys and header values use
 * Pi's config-value syntax: $ENV_VAR interpolation and a leading !command are
 * resolved by Pi at request time. A command therefore intentionally runs with
 * the Pi process user's permissions; keep commands in this user-owned file,
 * never put a secret directly in the command text, and use $! for a literal
 * leading exclamation mark.
 */

import { isPrivateHttpHostname } from "./net.ts";
import { sanitizeTerminalText } from "./sanitize.ts";

const SUPPORTED_APIS = new Set([
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"mistral-conversations",
	"google-generative-ai",
	"google-vertex",
	"bedrock-converse-stream",
	"pi-messages",
]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const ROOT_KEYS = new Set(["providers", "_notes"]);
const PROVIDER_KEYS = new Set([
	"id",
	"hidden",
	"name",
	"baseUrl",
	"apiKey",
	"api",
	"allowInsecureHttp",
	"authHeader",
	"headers",
	"compat",
	"quotaRetry",
	"models",
]);
const MODEL_KEYS = new Set([
	"id",
	"hidden",
	"api",
	"baseUrl",
	"name",
	"reasoning",
	"thinkingLevelMap",
	"input",
	"contextWindow",
	"maxTokens",
	"cost",
	"headers",
	"compat",
]);
const COST_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite", "tiers"]);
const COST_TIER_KEYS = new Set(["inputTokensAbove", "input", "output", "cacheRead", "cacheWrite"]);
const QUOTA_RETRY_KEYS = new Set(["maxRetries", "baseDelayMs", "backoff", "matchAll", "errorSubstrings"]);
const MAX_QUOTA_RETRIES = 10;
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_MAX_QUOTA_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
const LEGACY_QUOTA_RETRY_ERROR_SUBSTRINGS = [
	"insufficient_quota",
	"you exceeded your current quota",
] as const;

export const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface RelayCostRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface RelayCostConfig extends RelayCostRates {
	tiers?: (RelayCostRates & { inputTokensAbove: number })[];
}

export interface RelayModelConfig {
	id: string;
	/** Keep this model in the config without registering it. Default: false. */
	hidden?: boolean;
	api?: string;
	baseUrl?: string;
	name?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: RelayCostConfig;
	/** Values use the same trusted-local Pi config-value syntax as apiKey. */
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
}

export interface QuotaRetryConfig {
	maxRetries?: number;
	baseDelayMs?: number;
	/** "exponential" (default) doubles baseDelayMs each attempt; "fixed" always waits baseDelayMs. */
	backoff?: "exponential" | "fixed";
	/** When true, retry any pre-stream error regardless of its message text. */
	matchAll?: boolean;
	/** Case-insensitive literal substrings. No implicit regex interpretation. */
	errorSubstrings?: string[];
}

export interface RelayProviderConfig {
	id: string;
	/** Keep this provider and all its models in the config without registering them. Default: false. */
	hidden?: boolean;
	name?: string;
	baseUrl: string;
	/** Pi config value: literal, $ENV_VAR interpolation, or intentional leading !command. */
	apiKey: string;
	api?: string;
	/**
	 * Required to opt into plain HTTP. Even when true, HTTP is accepted only for
	 * localhost or literal loopback/private/link-local addresses. API keys and
	 * headers sent this way are plaintext on that local/private network.
	 */
	allowInsecureHttp?: boolean;
	authHeader?: boolean;
	/** Values use the same trusted-local Pi config-value syntax as apiKey. */
	headers?: Record<string, string>;
	/** Defaults applied to every model; model compat values take precedence. */
	compat?: Record<string, unknown>;
	/**
	 * Retry matching is explicitly opted in. `true` preserves the historical
	 * matching of the two LEGACY_QUOTA_RETRY_ERROR_SUBSTRINGS above; use an
	 * object with errorSubstrings to avoid retrying a provider's permanent
	 * billing/quota-exhaustion message.
	 */
	quotaRetry?: boolean | QuotaRetryConfig;
	models: RelayModelConfig[];
}

export interface RelayConfig {
	providers: RelayProviderConfig[];
	/** Documentation-only JSON footer used by the checked-in example. */
	_notes?: string[];
}

export interface QuotaRetryOptions {
	maxRetries: number;
	baseDelayMs: number;
	backoff: "exponential" | "fixed";
	matchAll: boolean;
	errorSubstrings: string[];
}

type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function rejectUnknownKeys(value: JsonObject, allowed: ReadonlySet<string>, path: string, errors: string[]): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			// Do not echo an attacker-controlled key: config errors reach the terminal,
			// and a key can itself contain credentials or terminal control characters.
			errors.push(`${path} contains an unsupported key`);
		}
	}
}

/**
 * Root/provider-level unknown keys are warnings, not errors: companion
 * extensions (e.g. relay-balance) own extra fields in this shared file, and a
 * hard error would couple this extension to every consumer's schema. The key
 * name is echoed (sanitized) so plain typos stay detectable.
 */
function warnUnknownKeys(value: JsonObject, allowed: ReadonlySet<string>, path: string, warnings: string[]): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			warnings.push(`${path} has unknown key "${sanitizeTerminalText(key, 64)}"; ignored (typo, or a field owned by another extension)`);
		}
	}
}

function validateHttpUrl(
	value: unknown,
	path: string,
	allowInsecureHttp: unknown,
	errors: string[],
): void {
	if (!isNonemptyString(value)) {
		errors.push(`${path} must be a nonempty HTTP(S) URL`);
		return;
	}
	try {
		const url = new URL(value);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
			errors.push(`${path} must be an absolute HTTP(S) URL`);
			return;
		}
		if (url.username || url.password) {
			errors.push(`${path} must not contain URL userinfo; configure authentication separately`);
		}
		if (url.protocol === "http:") {
			if (allowInsecureHttp !== true) {
				errors.push(`${path} requires provider allowInsecureHttp: true when using plain HTTP`);
			} else if (!isPrivateHttpHostname(url.hostname)) {
				errors.push(`${path} may use plain HTTP only with localhost or a literal private address`);
			}
		}
	} catch {
		errors.push(`${path} must be an absolute HTTP(S) URL`);
	}
}

function validateOptionalBoolean(value: unknown, path: string, errors: string[]): void {
	if (value !== undefined && typeof value !== "boolean") errors.push(`${path} must be a boolean`);
}

function validateOptionalNonemptyString(value: unknown, path: string, errors: string[]): void {
	if (value !== undefined && !isNonemptyString(value)) errors.push(`${path} must be a nonempty string`);
}

function validateApi(value: unknown, path: string, errors: string[]): void {
	if (!isNonemptyString(value) || !SUPPORTED_APIS.has(value)) {
		errors.push(`${path} must name a supported built-in API`);
	}
}

function validateHeaders(value: unknown, path: string, errors: string[]): void {
	if (value === undefined) return;
	if (!isObject(value)) {
		errors.push(`${path} must be an object of string header values`);
		return;
	}
	for (const [key, headerValue] of Object.entries(value)) {
		// RFC 9110 field-name token. Avoid echoing configured names or values in
		// errors, both to prevent log injection and to keep credential headers out.
		if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) {
			errors.push(`${path} contains an invalid HTTP header name`);
		}
		if (typeof headerValue !== "string") errors.push(`${path} contains a non-string header value`);
	}
}

function validateCompat(value: unknown, path: string, errors: string[]): void {
	// Compat is Pi's documented forward-compatibility escape hatch. Keep the
	// object open so newly installed Pi compat entries do not require an extension
	// release; strict validation still applies to surrounding model/provider keys.
	if (value !== undefined && !isObject(value)) errors.push(`${path} must be an object`);
}

function validateOptionalPositiveInteger(value: unknown, path: string, errors: string[]): void {
	if (value !== undefined && (!Number.isInteger(value) || (value as number) <= 0)) {
		errors.push(`${path} must be a positive integer`);
	}
}

function validateCost(value: unknown, path: string, errors: string[]): void {
	if (value === undefined) return;
	if (!isObject(value)) {
		errors.push(`${path} must contain input, output, cacheRead, and cacheWrite rates`);
		return;
	}
	const validateRates = (rates: JsonObject, ratesPath: string, allowedKeys: ReadonlySet<string>) => {
		rejectUnknownKeys(rates, allowedKeys, ratesPath, errors);
		for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const rate = rates[field];
			if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
				errors.push(`${ratesPath}.${field} must be a finite nonnegative number`);
			}
		}
	};
	validateRates(value, path, COST_KEYS);
	if (value.tiers !== undefined) {
		if (!Array.isArray(value.tiers) || value.tiers.length === 0) {
			errors.push(`${path}.tiers must be a nonempty array when provided`);
		} else {
			for (let index = 0; index < value.tiers.length; index += 1) {
				const tierPath = `${path}.tiers[${index}]`;
				const tier = value.tiers[index];
				if (!isObject(tier)) {
					errors.push(`${tierPath} must be an object`);
					continue;
				}
				validateRates(tier, tierPath, COST_TIER_KEYS);
				if (!Number.isInteger(tier.inputTokensAbove) || (tier.inputTokensAbove as number) < 0) {
					errors.push(`${tierPath}.inputTokensAbove must be a nonnegative integer`);
				}
			}
		}
	}
}

function validateThinkingLevelMap(value: unknown, path: string, errors: string[]): void {
	if (value === undefined) return;
	if (!isObject(value)) {
		errors.push(`${path} must be an object`);
		return;
	}
	for (const [level, mappedValue] of Object.entries(value)) {
		if (!THINKING_LEVELS.has(level)) errors.push(`${path} contains an unsupported thinking level`);
		if (mappedValue !== null && !isNonemptyString(mappedValue)) {
			errors.push(`${path}.${level} must be a nonempty string or null`);
		}
	}
}

function validateInput(value: unknown, path: string, errors: string[]): void {
	if (value === undefined) return;
	if (!Array.isArray(value) || value.length === 0) {
		errors.push(`${path} must be a nonempty array containing only "text" and/or "image"`);
		return;
	}
	const seen = new Set<string>();
	for (const item of value) {
		if (item !== "text" && item !== "image") errors.push(`${path} contains an unsupported input type`);
		if (typeof item === "string" && seen.has(item)) errors.push(`${path} must not contain duplicate input types`);
		if (typeof item === "string") seen.add(item);
	}
}

function validateQuotaRetry(value: unknown, providerApi: unknown, path: string, errors: string[]): void {
	if (value === undefined || value === false) return;
	if (value !== true && !isObject(value)) {
		errors.push(`${path} must be a boolean or retry-options object`);
		return;
	}
	if (providerApi !== undefined && providerApi !== "openai-completions") {
		errors.push(`${path} is supported only when the provider API is "openai-completions"`);
	}
	if (value === true) return;

	rejectUnknownKeys(value, QUOTA_RETRY_KEYS, path, errors);
	if (
		value.maxRetries !== undefined &&
		(!Number.isInteger(value.maxRetries) || (value.maxRetries as number) < 0 || (value.maxRetries as number) > MAX_QUOTA_RETRIES)
	) {
		errors.push(`${path}.maxRetries must be an integer from 0 through ${MAX_QUOTA_RETRIES}`);
	}
	if (
		value.baseDelayMs !== undefined &&
		(!Number.isInteger(value.baseDelayMs) || (value.baseDelayMs as number) < 250 || (value.baseDelayMs as number) > MAX_RETRY_DELAY_MS)
	) {
		errors.push(`${path}.baseDelayMs must be an integer from 250 through ${MAX_RETRY_DELAY_MS}`);
	}
	if (value.backoff !== undefined && value.backoff !== "exponential" && value.backoff !== "fixed") {
		errors.push(`${path}.backoff must be "exponential" or "fixed"`);
	}
	if (value.matchAll !== undefined && typeof value.matchAll !== "boolean") {
		errors.push(`${path}.matchAll must be a boolean`);
	}
	if (value.errorSubstrings !== undefined) {
		if (!Array.isArray(value.errorSubstrings) || value.errorSubstrings.length === 0) {
			errors.push(`${path}.errorSubstrings must be a nonempty array of nonempty strings`);
		} else {
			for (let index = 0; index < value.errorSubstrings.length; index += 1) {
				if (!isNonemptyString(value.errorSubstrings[index])) {
					errors.push(`${path}.errorSubstrings[${index}] must be a nonempty string`);
				}
			}
		}
	}
}

export function validateRelayConfig(value: unknown): { config: RelayConfig; warnings: string[] } {
	const errors: string[] = [];
	const warnings: string[] = [];
	if (!isObject(value)) {
		throw new Error("configuration root must be an object");
	}
	warnUnknownKeys(value, ROOT_KEYS, "configuration root", warnings);
	if (value._notes !== undefined && (
		!Array.isArray(value._notes) || value._notes.some((note) => typeof note !== "string")
	)) {
		errors.push("_notes must be an array of strings");
	}
	if (!Array.isArray(value.providers)) {
		errors.push("providers must be an array");
	}

	const providers = Array.isArray(value.providers) ? value.providers : [];
	const providerIds = new Set<string>();
	for (let providerIndex = 0; providerIndex < providers.length; providerIndex += 1) {
		const providerPath = `providers[${providerIndex}]`;
		const provider = providers[providerIndex];
		if (!isObject(provider)) {
			errors.push(`${providerPath} must be an object`);
			continue;
		}

		warnUnknownKeys(provider, PROVIDER_KEYS, providerPath, warnings);
		if (!isNonemptyString(provider.id)) {
			errors.push(`${providerPath}.id must be a nonempty string`);
		} else if (providerIds.has(provider.id)) {
			errors.push(`${providerPath}.id duplicates another provider ID`);
		} else {
			providerIds.add(provider.id);
		}
		validateOptionalNonemptyString(provider.name, `${providerPath}.name`, errors);
		validateOptionalBoolean(provider.hidden, `${providerPath}.hidden`, errors);
		validateOptionalBoolean(provider.allowInsecureHttp, `${providerPath}.allowInsecureHttp`, errors);
		validateHttpUrl(provider.baseUrl, `${providerPath}.baseUrl`, provider.allowInsecureHttp, errors);
		if (typeof provider.apiKey !== "string") errors.push(`${providerPath}.apiKey must be a string`);
		if (provider.api !== undefined) validateApi(provider.api, `${providerPath}.api`, errors);
		validateOptionalBoolean(provider.authHeader, `${providerPath}.authHeader`, errors);
		validateHeaders(provider.headers, `${providerPath}.headers`, errors);
		validateCompat(provider.compat, `${providerPath}.compat`, errors);
		validateQuotaRetry(provider.quotaRetry, provider.api, `${providerPath}.quotaRetry`, errors);

		if (!Array.isArray(provider.models) || provider.models.length === 0) {
			errors.push(`${providerPath}.models must be a nonempty array`);
			continue;
		}
		const modelIds = new Set<string>();
		for (let modelIndex = 0; modelIndex < provider.models.length; modelIndex += 1) {
			const modelPath = `${providerPath}.models[${modelIndex}]`;
			const model = provider.models[modelIndex];
			if (!isObject(model)) {
				errors.push(`${modelPath} must be an object`);
				continue;
			}
			rejectUnknownKeys(model, MODEL_KEYS, modelPath, errors);
			if (!isNonemptyString(model.id)) {
				errors.push(`${modelPath}.id must be a nonempty string`);
			} else if (modelIds.has(model.id)) {
				errors.push(`${modelPath}.id duplicates another model ID in this provider`);
			} else {
				modelIds.add(model.id);
			}
			validateOptionalNonemptyString(model.name, `${modelPath}.name`, errors);
			validateOptionalBoolean(model.hidden, `${modelPath}.hidden`, errors);
			validateOptionalBoolean(model.reasoning, `${modelPath}.reasoning`, errors);
			if (model.api !== undefined) {
				validateApi(model.api, `${modelPath}.api`, errors);
				if (isNonemptyString(model.api) && model.api !== (provider.api ?? "openai-completions")) {
					errors.push(`${modelPath}.api must match its provider API; split mixed APIs into separate providers`);
				}
			}
			if (model.baseUrl !== undefined) {
				validateHttpUrl(model.baseUrl, `${modelPath}.baseUrl`, provider.allowInsecureHttp, errors);
			}
			validateInput(model.input, `${modelPath}.input`, errors);
			validateOptionalPositiveInteger(model.contextWindow, `${modelPath}.contextWindow`, errors);
			validateOptionalPositiveInteger(model.maxTokens, `${modelPath}.maxTokens`, errors);
			validateCost(model.cost, `${modelPath}.cost`, errors);
			validateHeaders(model.headers, `${modelPath}.headers`, errors);
			validateCompat(model.compat, `${modelPath}.compat`, errors);
			validateThinkingLevelMap(model.thinkingLevelMap, `${modelPath}.thinkingLevelMap`, errors);
		}
	}

	if (errors.length > 0) {
		throw new Error(errors.map((error) => `- ${error}`).join("\n"));
	}
	return { config: value as unknown as RelayConfig, warnings };
}

export function normalizeQuotaRetry(config: RelayProviderConfig["quotaRetry"]): QuotaRetryOptions | undefined {
	if (!config) return undefined;
	const options = typeof config === "object" ? config : {};
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_QUOTA_RETRIES;
	if (maxRetries === 0) return undefined;
	return {
		maxRetries,
		baseDelayMs: options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
		backoff: options.backoff ?? "exponential",
		matchAll: options.matchAll === true,
		errorSubstrings: [...(options.errorSubstrings ?? LEGACY_QUOTA_RETRY_ERROR_SUBSTRINGS)],
	};
}
