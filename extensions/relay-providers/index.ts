/**
 * relay-providers.ts — Static relay provider registration
 *
 * Loads the manually curated providers and models from
 * ~/.pi/agent/relay-providers.json. Providers or models with `hidden: true`
 * are kept in the config but not registered. Opening /model does not trigger
 * relay network requests or a second model-list update.
 *
 * This is a trusted, user-local configuration. API keys and header values use
 * Pi's config-value syntax: $ENV_VAR interpolation and a leading !command are
 * resolved by Pi at request time. A command therefore intentionally runs with
 * the Pi process user's permissions; keep commands in this user-owned file,
 * never put a secret directly in the command text, and use $! for a literal
 * leading exclamation mark.
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
import {
	getApiProvider,
	isContextOverflow,
	isRetryableAssistantError,
	openAICompletionsApi,
} from "@earendil-works/pi-ai/compat";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "relay-providers.json");
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_MAX_QUOTA_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
const MAX_QUOTA_RETRIES = 10;
const MAX_RETRY_DELAY_MS = 60_000;
const RETRY_STATUS_PREFIX = "relay-quota-retry";
const LEGACY_QUOTA_RETRY_ERROR_SUBSTRINGS = [
	"insufficient_quota",
	"you exceeded your current quota",
] as const;
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
const OPENAI_BEARER_APIS = new Set(["openai-completions", "openai-responses"]);
const ROOT_KEYS = new Set(["providers", "kimiBalanceEnabled", "_notes"]);
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
	// Shared relay-footer fields. relay-providers validates but otherwise ignores
	// these so one documented config file can safely serve both extensions.
	"balanceEnabled",
	"balanceType",
	"balanceAccessToken",
	"balanceUserId",
	"balanceUserHeader",
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
const QUOTA_RETRY_KEYS = new Set(["maxRetries", "baseDelayMs", "errorSubstrings"]);
const MAX_STATUS_LABEL_LENGTH = 48;

interface RelayCostRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface RelayCostConfig extends RelayCostRates {
	tiers?: (RelayCostRates & { inputTokensAbove: number })[];
}

interface RelayModelConfig {
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

interface QuotaRetryConfig {
	maxRetries?: number;
	baseDelayMs?: number;
	/** Case-insensitive literal substrings. No implicit regex interpretation. */
	errorSubstrings?: string[];
}

interface RelayProviderConfig {
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
	/** Shared relay-footer settings; validated here but consumed by relay-footer. */
	balanceEnabled?: boolean;
	balanceType?: "rix";
	balanceAccessToken?: string;
	balanceUserId?: string;
	balanceUserHeader?: string;
	models: RelayModelConfig[];
}

interface RelayConfig {
	providers: RelayProviderConfig[];
	/** Shared relay-footer setting; validated here but consumed by relay-footer. */
	kimiBalanceEnabled?: boolean;
	/** Documentation-only JSON footer used by the checked-in example. */
	_notes?: string[];
}

interface QuotaRetryOptions {
	maxRetries: number;
	baseDelayMs: number;
	errorSubstrings: string[];
}

type OpenAICompletionsStream = (
	model: Model<"openai-completions">,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
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

function validateOptionalString(value: unknown, path: string, errors: string[]): void {
	if (value !== undefined && typeof value !== "string") errors.push(`${path} must be a string`);
}

function validateOptionalHeaderName(value: unknown, path: string, errors: string[]): void {
	if (value === undefined) return;
	if (typeof value !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)) {
		errors.push(`${path} must be a valid HTTP header name`);
	}
}

function sanitizeTerminalText(value: string, maxLength: number): string {
	const withoutSequences = value
		// OSC, DCS, SOS, PM and APC strings, including their C1 forms.
		.replace(/(?:\x1B\]|\x9D)[\s\S]*?(?:\x07|\x1B\\|\x9C)/g, "")
		.replace(/(?:\x1B[P_X^]|[\x90\x98\x9E\x9F])[\s\S]*?(?:\x1B\\|\x9C)/g, "")
		// CSI, remaining ESC sequences, C0/C1 controls, and bidi reordering.
		.replace(/(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1B[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1F\x7F-\x9F]/g, " ")
		.replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return Array.from(withoutSequences).slice(0, maxLength).join("");
}

function sanitizeProviderLabel(value: string): string {
	return sanitizeTerminalText(value, MAX_STATUS_LABEL_LENGTH) || "relay-provider";
}

function isPrivateIpv4(hostname: string): boolean {
	const octets = hostname.split(".").map(Number);
	if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
		return false;
	}
	const [first, second] = octets as [number, number, number, number];
	return (
		first === 10 ||
		first === 127 ||
		(first === 169 && second === 254) ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 168)
	);
}

function isPrivateHttpHostname(hostname: string): boolean {
	const normalized = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
	if (isPrivateIpv4(normalized)) return true;

	// URL normalizes IPv6 literals, so prefix checks are sufficient for loopback,
	// RFC 4193 unique-local (fc00::/7), and RFC 4291 link-local (fe80::/10).
	return normalized.includes(":") && (
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		/^fe[89ab]/.test(normalized)
	);
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

function validateRelayConfig(value: unknown): RelayConfig {
	const errors: string[] = [];
	if (!isObject(value)) {
		throw new Error("configuration root must be an object");
	}
	rejectUnknownKeys(value, ROOT_KEYS, "configuration root", errors);
	validateOptionalBoolean(value.kimiBalanceEnabled, "kimiBalanceEnabled", errors);
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

		rejectUnknownKeys(provider, PROVIDER_KEYS, providerPath, errors);
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
		validateOptionalBoolean(provider.balanceEnabled, `${providerPath}.balanceEnabled`, errors);
		if (provider.balanceType !== undefined && provider.balanceType !== "rix") {
			errors.push(`${providerPath}.balanceType must be "rix"`);
		}
		validateOptionalString(provider.balanceAccessToken, `${providerPath}.balanceAccessToken`, errors);
		validateOptionalString(provider.balanceUserId, `${providerPath}.balanceUserId`, errors);
		validateOptionalHeaderName(provider.balanceUserHeader, `${providerPath}.balanceUserHeader`, errors);

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
	return value as unknown as RelayConfig;
}

function normalizeQuotaRetry(config: RelayProviderConfig["quotaRetry"]): QuotaRetryOptions | undefined {
	if (!config) return undefined;
	const options = typeof config === "object" ? config : {};
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_QUOTA_RETRIES;
	if (maxRetries === 0) return undefined;
	return {
		maxRetries,
		baseDelayMs: options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
		errorSubstrings: [...(options.errorSubstrings ?? LEGACY_QUOTA_RETRY_ERROR_SUBSTRINGS)],
	};
}

function isConfiguredRetryError(message: string | undefined, retry: QuotaRetryOptions): boolean {
	if (!message) return false;
	const normalized = message.toLocaleLowerCase();
	return retry.errorSubstrings.some((substring) => normalized.includes(substring.toLocaleLowerCase()));
}

function sanitizeRelayError(message: AssistantMessage): AssistantMessage {
	// Provider/SDK error strings are untrusted and can echo request headers or
	// credentials. Do not attempt best-effort substring redaction: configured
	// values are resolved inside Pi and are not all available to this extension.
	const aborted = message.stopReason === "aborted";
	return {
		...message,
		content: [],
		diagnostics: undefined,
		stopReason: aborted ? "aborted" : "error",
		errorMessage: aborted
			? "Request was aborted"
			: "Relay request failed; inspect the relay without logging request credentials",
	};
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

interface RetryStatusTracker {
	createHandle(): RetryStatusHandle;
	clearAll(): void;
}

function createRetryStatusTracker(getSessionContext: () => ExtensionContext | undefined): RetryStatusTracker {
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

function createQuotaRetryStream(
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

				// Match before sanitizing so explicitly configured retry substrings retain
				// their intended behavior, then discard the provider's raw error text.
				const shouldRetry =
					!emitted &&
					!options?.signal?.aborted &&
					requestError.stopReason === "error" &&
					isConfiguredRetryError(requestError.errorMessage, retry) &&
					attempt < retry.maxRetries;
				const safeRequestError = sanitizeRelayError(requestError);
				lastError = safeRequestError;

				if (!shouldRetry) {
					status.clear();
					const aborted = options?.signal?.aborted || safeRequestError.stopReason === "aborted";
					output.push({
						type: "error",
						reason: aborted ? "aborted" : "error",
						error: aborted ? makeAbortedMessage(model, safeRequestError) : safeRequestError,
					});
					output.end();
					return;
				}

				attempt += 1;
				const delayMs = Math.min(MAX_RETRY_DELAY_MS, retry.baseDelayMs * 2 ** (attempt - 1));
				status.set(
					`${providerLabel} configured retry · ${attempt}/${retry.maxRetries} in ${delayMs / 1000}s · Esc cancels`,
				);
				if (!(await waitForRetry(delayMs, options?.signal))) {
					status.clear();
					output.push({ type: "error", reason: "aborted", error: makeAbortedMessage(model, safeRequestError) });
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

function createSanitizedStream(api: string): OpenAICompletionsStream {
	return (model, context, options) => {
		const output = createAssistantMessageEventStream();
		void (async () => {
			const implementation = getApiProvider(api);
			if (!implementation) throw new Error("unsupported API implementation");
			for await (const event of implementation.streamSimple(model, context, options)) {
				if (event.type === "error") {
					const safeError = sanitizeRelayError(event.error);
					output.push({
						type: "error",
						reason: safeError.stopReason === "aborted" ? "aborted" : "error",
						error: safeError,
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
	statusTracker: RetryStatusTracker,
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
			// Always wrap relay streams so provider/SDK errors cannot echo configured
			// API keys or header values into the UI/session. Retry adds the same
			// sanitization after matching the configured raw error substring.
			streamSimple: (quotaRetry
				? createQuotaRetryStream(provider.name ?? provider.id, quotaRetry, statusTracker)
				: createSanitizedStream(api)) as never,
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
		config = validateRelayConfig(rawConfig);
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

	pi.on("session_shutdown", () => {
		retryStatusTracker.clearAll();
		sessionContext = undefined;
		// ModelRuntime survives /reload and session replacement. The outgoing
		// extension instance owns cleanup; the new instance registers only once.
		unregisterManagedProviders(pi, config);
	});
}
