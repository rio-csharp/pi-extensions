import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const WEB_CONFIG_FILE = "web.json";
const MAX_SEARCH_PROVIDERS = 8;

export interface SearxngProviderConfig {
	id: "searxng";
	endpoint: string;
	basicAuth?: string;
}

export type SearchProviderConfig = "duckduckgo" | "bing" | SearxngProviderConfig;

export interface FetchRelayConfig {
	endpoint: string;
	token: string;
}

export interface WebConfig {
	searchProviders: SearchProviderConfig[];
	fetchRelay?: FetchRelayConfig;
	warnings: string[];
}

function defaultConfig(): WebConfig {
	return { searchProviders: ["duckduckgo", "bing"], warnings: [] };
}

function expandEnvRef(value: string): string | undefined {
	if (!value.startsWith("$")) return value;
	return process.env[value.slice(1)];
}

function parseProviderEntry(entry: unknown, warnings: string[]): SearchProviderConfig | undefined {
	if (entry === "duckduckgo" || entry === "bing") return entry;
	if (typeof entry === "string") {
		warnings.push(`${WEB_CONFIG_FILE}: unknown search provider "${entry}" skipped.`);
		return undefined;
	}
	if (!entry || typeof entry !== "object" || (entry as { id?: unknown }).id !== "searxng") {
		warnings.push(`${WEB_CONFIG_FILE}: unrecognized search provider entry skipped.`);
		return undefined;
	}
	const { endpoint, basicAuth } = entry as { endpoint?: unknown; basicAuth?: unknown };
	if (typeof endpoint !== "string" || endpoint.trim() === "") {
		warnings.push(`${WEB_CONFIG_FILE}: searxng provider requires an endpoint, skipped.`);
		return undefined;
	}
	let url: URL;
	try {
		url = new URL(endpoint.trim());
	} catch {
		warnings.push(`${WEB_CONFIG_FILE}: searxng endpoint is not a valid URL, skipped.`);
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		warnings.push(`${WEB_CONFIG_FILE}: searxng endpoint must be http(s), skipped.`);
		return undefined;
	}
	if (url.username || url.password) {
		warnings.push(`${WEB_CONFIG_FILE}: searxng endpoint must not embed credentials; use basicAuth, skipped.`);
		return undefined;
	}
	let auth: string | undefined;
	if (basicAuth !== undefined) {
		if (typeof basicAuth !== "string" || basicAuth.trim() === "") {
			warnings.push(`${WEB_CONFIG_FILE}: searxng basicAuth must be a non-empty string, skipped.`);
			return undefined;
		}
		auth = expandEnvRef(basicAuth.trim());
		if (!auth) {
			warnings.push(`${WEB_CONFIG_FILE}: searxng basicAuth reference is unset, provider skipped.`);
			return undefined;
		}
		if (url.protocol === "http:") {
			warnings.push(`${WEB_CONFIG_FILE}: searxng basicAuth over plain http is sent in cleartext.`);
		}
	}
	return { id: "searxng", endpoint: url.toString(), basicAuth: auth };
}

function parseFetchRelay(entry: unknown, warnings: string[]): FetchRelayConfig | undefined {
	if (entry === undefined) return undefined;
	const { endpoint, token } = (entry ?? {}) as { endpoint?: unknown; token?: unknown };
	if (typeof endpoint !== "string" || typeof token !== "string") {
		warnings.push(`${WEB_CONFIG_FILE}: fetchRelay requires endpoint and token, ignored.`);
		return undefined;
	}
	let url: URL;
	try {
		url = new URL(endpoint.trim());
	} catch {
		warnings.push(`${WEB_CONFIG_FILE}: fetchRelay endpoint is not a valid URL, ignored.`);
		return undefined;
	}
	if (url.protocol !== "https:" || url.username || url.password) {
		warnings.push(`${WEB_CONFIG_FILE}: fetchRelay endpoint must be https without embedded credentials, ignored.`);
		return undefined;
	}
	const expandedToken = expandEnvRef(token.trim());
	if (!expandedToken) {
		warnings.push(`${WEB_CONFIG_FILE}: fetchRelay token reference is unset, ignored.`);
		return undefined;
	}
	return { endpoint: url.toString(), token: expandedToken };
}

export function loadWebConfig(agentDir = getAgentDir()): WebConfig {
	const warnings: string[] = [];
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(agentDir, WEB_CONFIG_FILE), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
		return { ...defaultConfig(), warnings: [`${WEB_CONFIG_FILE}: not valid JSON, using defaults.`] };
	}
	const list = (raw as { searchProviders?: unknown })?.searchProviders;
	const fetchRelay = parseFetchRelay((raw as { fetchRelay?: unknown })?.fetchRelay, warnings);
	if (list === undefined) return { ...defaultConfig(), fetchRelay, warnings };
	if (!Array.isArray(list) || list.length === 0) {
		return { ...defaultConfig(), fetchRelay, warnings: [...warnings, `${WEB_CONFIG_FILE}: searchProviders must be a non-empty array, using defaults.`] };
	}
	const providers = list
		.slice(0, MAX_SEARCH_PROVIDERS)
		.map((entry) => parseProviderEntry(entry, warnings))
		.filter((provider): provider is SearchProviderConfig => provider !== undefined);
	if (providers.length === 0) {
		return { ...defaultConfig(), fetchRelay, warnings: [...warnings, `${WEB_CONFIG_FILE}: no usable search providers, using defaults.`] };
	}
	return { searchProviders: providers, fetchRelay, warnings };
}
