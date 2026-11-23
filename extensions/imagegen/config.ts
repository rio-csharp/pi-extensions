import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const IMAGEGEN_CONFIG_FILE = "imagegen.json";
export const RELAY_CONFIG_FILE = "relay-providers.json";

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

/** Presets documented by the OpenAI image API. */
export const PRESET_SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;

const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_PRICE_PER_IMAGE = 0.02;

export interface ModelConfig {
	/** Provider model id, for example "gpt-image-2.6-flare". */
	id: string;
	/** Shown to the model so it knows when to pick this entry. */
	description: string;
	/** Default quality for this entry, overriding the top-level default. */
	quality?: Quality;
	/** Billed USD per generated image for this entry. */
	pricePerImage?: number;
}

export interface ImageGenConfig {
	/** Provider id in relay-providers.json whose baseUrl and apiKey are reused. */
	provider?: string;
	baseUrl: string;
	apiKey: string;
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
		baseUrl: "",
		apiKey: "",
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

interface RelayCredentials {
	baseUrl?: string;
	apiKey?: string;
}

function readRelayProvider(agentDir: string, providerId: string, warnings: string[]): RelayCredentials {
	let raw: unknown;
	try {
		raw = readJson(join(agentDir, RELAY_CONFIG_FILE));
	} catch {
		warnings.push(`${RELAY_CONFIG_FILE}: not valid JSON, provider "${providerId}" ignored.`);
		return {};
	}
	if (!raw || typeof raw !== "object") {
		warnings.push(`${RELAY_CONFIG_FILE}: unexpected shape, provider "${providerId}" ignored.`);
		return {};
	}
	const providers = (raw as { providers?: unknown }).providers;
	if (!Array.isArray(providers)) {
		warnings.push(`${RELAY_CONFIG_FILE}: no providers array, provider "${providerId}" ignored.`);
		return {};
	}
	const entry = providers.find(
		(candidate) => candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === providerId,
	);
	if (!entry) {
		warnings.push(`provider "${providerId}" is not defined in ${RELAY_CONFIG_FILE}.`);
		return {};
	}
	const { baseUrl, apiKey } = entry as { baseUrl?: unknown; apiKey?: unknown };
	const resolved: RelayCredentials = {};
	if (typeof baseUrl === "string" && baseUrl.trim() !== "") resolved.baseUrl = baseUrl.trim();
	if (typeof apiKey === "string" && apiKey.trim() !== "") {
		const expanded = expandEnvRef(apiKey);
		if (expanded) resolved.apiKey = expanded;
		else warnings.push(`provider "${providerId}" apiKey reference is unset.`);
	}
	return resolved;
}

function normalizeBaseUrl(value: string, warnings: string[]): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		warnings.push(`${IMAGEGEN_CONFIG_FILE}: base URL is not a valid URL.`);
		return "";
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		warnings.push(`${IMAGEGEN_CONFIG_FILE}: base URL must be http(s).`);
		return "";
	}
	if (url.username || url.password) {
		warnings.push(`${IMAGEGEN_CONFIG_FILE}: base URL must not embed credentials.`);
		return "";
	}
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString();
}

/** Billed cost for `count` images at `pricePerImage`, rounded to cents' worth of precision. */
export function imageCostUsd(pricePerImage: number, count: number): number {
	if (!Number.isFinite(pricePerImage) || !Number.isFinite(count) || count <= 0) return 0;
	return Math.round(pricePerImage * count * 10_000) / 10_000;
}

function parsePrice(value: unknown, fallback: number, label: string, warnings: string[]): number {
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	warnings.push(`${IMAGEGEN_CONFIG_FILE}: ${label} must be a non-negative number, using ${fallback}.`);
	return fallback;
}

function parseModels(entry: unknown, warnings: string[]): Record<string, ModelConfig> {
	const models = defaultModels();
	if (entry === undefined) return models;
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		warnings.push(`${IMAGEGEN_CONFIG_FILE}: models must be an object, using built-in entries.`);
		return models;
	}
	for (const [alias, value] of Object.entries(entry as Record<string, unknown>)) {
		if (!/^[a-z0-9][a-z0-9_-]*$/i.test(alias)) {
			warnings.push(`${IMAGEGEN_CONFIG_FILE}: model alias "${alias}" must be alphanumeric, skipped.`);
			continue;
		}
		const { id, description, quality, pricePerImage } = (value ?? {}) as {
			id?: unknown;
			description?: unknown;
			quality?: unknown;
			pricePerImage?: unknown;
		};
		if (typeof id !== "string" || id.trim() === "") {
			warnings.push(`${IMAGEGEN_CONFIG_FILE}: model "${alias}" requires an id, skipped.`);
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
			warnings.push(`${IMAGEGEN_CONFIG_FILE}: model "${alias}" has an unknown quality, ignored.`);
		}
		if (pricePerImage !== undefined) {
			model.pricePerImage = parsePrice(pricePerImage, 0, `model "${alias}" pricePerImage`, warnings);
		}
		models[alias] = model;
	}
	return models;
}

function parseString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
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

	if (typeof file.provider === "string" && file.provider.trim() !== "") {
		config.provider = file.provider.trim();
		const relay = readRelayProvider(agentDir, config.provider, warnings);
		config.baseUrl = relay.baseUrl ?? "";
		config.apiKey = relay.apiKey ?? "";
	}

	if (typeof file.baseUrl === "string" && file.baseUrl.trim() !== "") {
		const normalized = normalizeBaseUrl(file.baseUrl, warnings);
		if (normalized) config.baseUrl = normalized;
	} else if (config.baseUrl) {
		config.baseUrl = normalizeBaseUrl(config.baseUrl, warnings) || config.baseUrl;
	}

	if (typeof file.apiKey === "string" && file.apiKey.trim() !== "") {
		const expanded = expandEnvRef(file.apiKey);
		if (expanded) config.apiKey = expanded;
		else warnings.push(`${IMAGEGEN_CONFIG_FILE}: apiKey reference is unset.`);
	}

	if (!config.baseUrl) config.baseUrl = expandEnvRef("$IMAGEGEN_BASE_URL") ?? "";
	if (!config.apiKey) config.apiKey = expandEnvRef("$IMAGEGEN_API_KEY") ?? "";

	config.models = parseModels(file.models, warnings);
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
	if (!config.baseUrl) return `no base URL: set "provider" or "baseUrl" in ~/.pi/agent/${IMAGEGEN_CONFIG_FILE}`;
	if (!config.apiKey) return `no API key: set "provider" or "apiKey" in ~/.pi/agent/${IMAGEGEN_CONFIG_FILE}`;
	if (Object.keys(config.models).length === 0) return "no image models configured";
	return undefined;
}
