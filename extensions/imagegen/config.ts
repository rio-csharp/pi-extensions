import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const IMAGEGEN_CONFIG_FILE = "imagegen.json";

export const QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"] as const;
export type Quality = (typeof QUALITIES)[number];

export const BACKGROUNDS = ["auto", "transparent", "opaque"] as const;
export type Background = (typeof BACKGROUNDS)[number];

export const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const COMPLEXITIES = ["low", "medium", "high"] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

export const MODERATIONS = ["auto", "low"] as const;
export type Moderation = (typeof MODERATIONS)[number];

/** Image API shapes this extension can speak; each one lives in dialects/. */
export const IMAGE_APIS = ["openai", "sensenova"] as const;
export type ImageApi = (typeof IMAGE_APIS)[number];

const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_PRICE_PER_IMAGE = 0.02;

/** One vendor endpoint: everything a request needs before a model id is added. */
export interface ProviderConfig {
	/** Request shape this endpoint speaks. */
	api: ImageApi;
	/** Endpoint including the API version segment, for example `https://api.ai-pixel.online/v1`. */
	baseUrl: string;
	/** Resolved key. Empty when the config left it out or its `$ENV_VAR` reference was unset. */
	apiKey: string;
}

export interface ModelConfig {
	/** Provider model id, for example "gpt-image-2.6-flare". */
	id: string;
	/** Shown to the model so it knows when to pick this entry. */
	description: string;
	/** Key in `providers` whose endpoint serves this model. Required: a model is never guessed onto an endpoint. */
	provider?: string;
	/** Default quality for this entry, overriding the top-level default. OpenAI dialect only. */
	quality?: Quality;
	/** Billed USD per generated image for this entry. */
	pricePerImage?: number;
}

/** Endpoint a model resolves to, plus the provider it came from. */
export interface ModelEndpoint {
	provider?: string;
	baseUrl?: string;
	apiKey?: string;
}

export interface ImageGenConfig {
	/** Every vendor endpoint declared in the config file, keyed by the name models use. */
	providers: Record<string, ProviderConfig>;
	models: Record<string, ModelConfig>;
	defaultModel: string;
	defaultQuality: Quality;
	defaultSize: string;
	/** Billed USD per generated image, used for usage accounting. */
	pricePerImage: number;
	outputDir: string;
	timeoutMs: number;
	warnings: string[];
}

export function defaultModels(): Record<string, ModelConfig> {
	return {
		flare: {
			id: "gpt-image-2.6-flare",
			description:
				"Fast iteration: quicker (roughly 15-90s) and better at finished-looking layout, so use it for drafts, variants and anything a user is waiting on.",
		},
		sunburst: {
			id: "gpt-image-2.6-sunburst",
			description:
				"Slower but more literal: honors requested placement, keeps more detail and drifts less across multi-round edits, so use it for final assets and edits that must not disturb the rest of the image.",
		},
	};
}

function defaultConfig(warnings: string[] = []): ImageGenConfig {
	return {
		providers: {},
		models: defaultModels(),
		defaultModel: "flare",
		defaultQuality: "medium",
		defaultSize: "1024x1024",
		pricePerImage: DEFAULT_PRICE_PER_IMAGE,
		outputDir: "generated",
		timeoutMs: DEFAULT_TIMEOUT_MS,
		warnings,
	};
}

/** Expand `$NAME` / `${NAME}` references; other values are returned as is. */
export function expandEnvRef(value: string): string | undefined {
	const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value.trim());
	if (!match) return value;
	return process.env[match[1]!];
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

function normalizeBaseUrl(value: string, label: string, warnings: string[]): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		warnings.push(`${label}: base URL is not a valid URL.`);
		return "";
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		warnings.push(`${label}: base URL must be http(s).`);
		return "";
	}
	if (url.username || url.password) {
		warnings.push(`${label}: base URL must not embed credentials.`);
		return "";
	}
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString();
}

/** Expand a configured key, treating an unset `$ENV_VAR` reference as missing rather than literal. */
function parseApiKey(value: unknown, label: string, warnings: string[]): string {
	if (value === undefined) return "";
	if (typeof value !== "string" || value.trim() === "") {
		warnings.push(`${label}: apiKey must be a non-empty string, ignored.`);
		return "";
	}
	const expanded = expandEnvRef(value);
	if (!expanded) {
		warnings.push(`${label}: apiKey reference is unset.`);
		return "";
	}
	return expanded;
}

function parsePrice(value: unknown, fallback: number, label: string, warnings: string[]): number {
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	warnings.push(`${IMAGEGEN_CONFIG_FILE}: ${label} must be a non-negative number, using ${fallback}.`);
	return fallback;
}

function parseString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function parseApi(value: unknown, fallback: ImageApi, label: string, warnings: string[]): ImageApi {
	if (value === undefined) return fallback;
	if (typeof value === "string" && (IMAGE_APIS as readonly string[]).includes(value)) return value as ImageApi;
	warnings.push(`${label}: unknown api "${String(value)}", using "${fallback}".`);
	return fallback;
}

function parseProviders(entry: unknown, warnings: string[]): Record<string, ProviderConfig> {
	const providers: Record<string, ProviderConfig> = {};
	if (entry === undefined) return providers;
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		warnings.push(`${IMAGEGEN_CONFIG_FILE}: providers must be an object, ignored.`);
		return providers;
	}
	for (const [name, value] of Object.entries(entry as Record<string, unknown>)) {
		const label = `${IMAGEGEN_CONFIG_FILE}: provider "${name}"`;
		if (!NAME_PATTERN.test(name)) {
			warnings.push(`${label}: name must be alphanumeric, skipped.`);
			continue;
		}
		const { api, baseUrl, apiKey } = (value ?? {}) as { api?: unknown; baseUrl?: unknown; apiKey?: unknown };
		if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
			warnings.push(`${label}: baseUrl is required, skipped.`);
			continue;
		}
		const normalized = normalizeBaseUrl(baseUrl, label, warnings);
		if (!normalized) continue;
		providers[name] = {
			api: parseApi(api, "openai", label, warnings),
			baseUrl: normalized,
			apiKey: parseApiKey(apiKey, label, warnings),
		};
	}
	return providers;
}

function parseModels(entry: unknown, warnings: string[]): Record<string, ModelConfig> {
	const models = defaultModels();
	if (entry === undefined) return models;
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		warnings.push(`${IMAGEGEN_CONFIG_FILE}: models must be an object, using built-in entries.`);
		return models;
	}
	for (const [alias, value] of Object.entries(entry as Record<string, unknown>)) {
		const label = `${IMAGEGEN_CONFIG_FILE}: model "${alias}"`;
		if (!NAME_PATTERN.test(alias)) {
			warnings.push(`${label}: alias must be alphanumeric, skipped.`);
			continue;
		}
		const { id, description, quality, pricePerImage, provider } = (value ?? {}) as {
			id?: unknown;
			description?: unknown;
			quality?: unknown;
			pricePerImage?: unknown;
			provider?: unknown;
		};
		if (typeof id !== "string" || id.trim() === "") {
			warnings.push(`${label}: requires an id, skipped.`);
			continue;
		}
		const model: ModelConfig = {
			id: id.trim(),
			description:
				typeof description === "string" && description.trim() !== ""
					? description.trim()
					: `Model ${id.trim()}.`,
		};
		if (typeof quality === "string" && (QUALITIES as readonly string[]).includes(quality)) {
			model.quality = quality as Quality;
		} else if (quality !== undefined) {
			warnings.push(`${label}: unknown quality, ignored.`);
		}
		if (pricePerImage !== undefined) {
			model.pricePerImage = parsePrice(pricePerImage, 0, `model "${alias}" pricePerImage`, warnings);
		}
		if (typeof provider === "string" && provider.trim() !== "") {
			model.provider = provider.trim();
		} else if (provider !== undefined) {
			warnings.push(`${label}: provider must be a non-empty string, ignored.`);
		}
		models[alias] = model;
	}
	return models;
}

/** Provider name a model entry resolves to. */
export function modelProvider(config: ImageGenConfig, alias: string): string | undefined {
	return config.models[alias]?.provider;
}

/** Effective credentials for one model entry. */
export function modelEndpoint(config: ImageGenConfig, alias: string): ModelEndpoint {
	const name = modelProvider(config, alias);
	const provider = name === undefined ? undefined : config.providers[name];
	return { provider: name, baseUrl: provider?.baseUrl, apiKey: provider?.apiKey };
}

/** Effective request shape for one model entry, taken from its provider. */
export function modelApi(config: ImageGenConfig, alias: string): ImageApi {
	const name = modelProvider(config, alias);
	return (name === undefined ? undefined : config.providers[name]?.api) ?? "openai";
}

/** Problem with one provider, for a targeted error message. */
export function providerProblem(provider: ProviderConfig | undefined, name: string): string | undefined {
	if (!provider) return `provider "${name}" is not defined in ~/.pi/agent/${IMAGEGEN_CONFIG_FILE}`;
	if (!provider.baseUrl) return `provider "${name}" has no base URL`;
	if (!provider.apiKey) return `provider "${name}" has no API key`;
	return undefined;
}

/** Problem with one model entry, for a targeted error message. */
export function modelProblem(config: ImageGenConfig, alias: string): string | undefined {
	const name = modelProvider(config, alias);
	if (name === undefined) {
		return `model "${alias}" names no provider in ~/.pi/agent/${IMAGEGEN_CONFIG_FILE}`;
	}
	return providerProblem(config.providers[name], name);
}

export function loadImageGenConfig(agentDir = getAgentDir()): ImageGenConfig {
	const warnings: string[] = [];
	let raw: unknown;
	try {
		raw = readJson(join(agentDir, IMAGEGEN_CONFIG_FILE));
	} catch {
		return defaultConfig([`${IMAGEGEN_CONFIG_FILE}: not valid JSON, using defaults.`]);
	}
	const file = (raw ?? {}) as Record<string, unknown>;
	const config = defaultConfig(warnings);

	for (const legacy of ["baseUrl", "apiKey", "api", "provider", "defaultProvider"]) {
		if (file[legacy] !== undefined) {
			warnings.push(
				`${IMAGEGEN_CONFIG_FILE}: top-level "${legacy}" is not used; declare it inside a provider entry.`,
			);
		}
	}

	config.providers = parseProviders(file.providers, warnings);
	config.models = parseModels(file.models, warnings);
	for (const [alias, model] of Object.entries(config.models)) {
		if (model.provider && !Object.hasOwn(config.providers, model.provider)) {
			warnings.push(
				`${IMAGEGEN_CONFIG_FILE}: model "${alias}" uses provider "${model.provider}", which is not defined.`,
			);
		}
	}

	const defaultModel = parseString(file.defaultModel, "flare");
	if (!config.models[defaultModel]) {
		const fallback = Object.keys(config.models)[0] ?? "flare";
		warnings.push(`${IMAGEGEN_CONFIG_FILE}: defaultModel "${defaultModel}" is unknown, using "${fallback}".`);
		config.defaultModel = fallback;
	} else {
		config.defaultModel = defaultModel;
	}
	const defaultModelsEntry = config.models[config.defaultModel];
	const modelQuality = defaultModelsEntry?.quality ?? "medium";

	const quality = parseString(file.defaultQuality, modelQuality);
	if (!(QUALITIES as readonly string[]).includes(quality)) {
		warnings.push(`${IMAGEGEN_CONFIG_FILE}: unknown defaultQuality "${quality}", using "medium".`);
		config.defaultQuality = "medium";
	} else {
		config.defaultQuality = quality as Quality;
	}

	config.defaultSize = parseString(file.defaultSize, "1024x1024");
	config.pricePerImage = parsePrice(file.pricePerImage, DEFAULT_PRICE_PER_IMAGE, "pricePerImage", warnings);
	config.outputDir = parseString(file.outputDir, "generated");

	const timeoutSeconds = file.timeoutSeconds;
	if (typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
		config.timeoutMs = Math.min(Math.max(timeoutSeconds, 30), 1800) * 1000;
	} else if (timeoutSeconds !== undefined) {
		warnings.push(`${IMAGEGEN_CONFIG_FILE}: timeoutSeconds must be a positive number, using 600.`);
	}

	return config;
}

/** Error text for a config that cannot generate anything. */
export function configProblem(config: ImageGenConfig): string | undefined {
	const aliases = Object.keys(config.models);
	if (aliases.length === 0) return "no image models configured";
	if (Object.keys(config.providers).length === 0) {
		return `no providers: define "providers" in ~/.pi/agent/${IMAGEGEN_CONFIG_FILE}`;
	}
	for (const alias of aliases) {
		if (!modelProblem(config, alias)) return undefined;
	}
	return modelProblem(config, aliases[0]!);
}

/** Billed cost for `count` images at `pricePerImage`, rounded to cents' worth of precision. */
export function imageCostUsd(pricePerImage: number, count: number): number {
	if (!Number.isFinite(pricePerImage) || !Number.isFinite(count) || count <= 0) return 0;
	return Math.round(pricePerImage * count * 10_000) / 10_000;
}
