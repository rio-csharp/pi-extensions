import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_REDIRECTS = 5;
const MAX_URL_LENGTH = 8192;
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_CURL_VERSION = [8, 4, 0] as const;

// curl exit codes that mean "the network path failed" rather than "the server answered".
const TRANSPORT_EXIT_CODES = new Set([5, 6, 7, 28, 35, 52, 56]);

export class TransportError extends Error {}

// DNS-poisoned domains resolve to reserved addresses; IP literals typed by the caller must never be relayed.
export class BlockedHostError extends Error {
	readonly literalIp: boolean;
	constructor(message: string, literalIp: boolean) {
		super(message);
		this.literalIp = literalIp;
	}
}

export interface RequestOptions {
	timeoutMs?: number;
	extraArgs?: string[];
}

// SSRF guard: web_fetch must never reach loopback, private, or reserved addresses.
const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) blockedIpv4.addSubnet(network, prefix, "ipv4");

const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
	["::", 128],
	["::1", 128],
	["::", 96],
	["::ffff:0:0", 96],
	["5f00::", 16],
	["64:ff9b::", 96],
	["64:ff9b:1::", 48],
	["100::", 64],
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["3fff::", 20],
	["fc00::", 7],
	["fe80::", 10],
	["fec0::", 10],
	["ff00::", 8],
] as const) blockedIpv6.addSubnet(network, prefix, "ipv6");

function isPrivateAddress(address: string): boolean {
	const normalized = address.toLowerCase().split("%")[0];
	const family = isIP(normalized);
	if (family === 4) return blockedIpv4.check(normalized, "ipv4");
	if (family === 6) return blockedIpv6.check(normalized, "ipv6");
	return true;
}

export function parseWebUrl(value: string, base?: URL): URL {
	if (value.length > MAX_URL_LENGTH || /[\0-\x1f\x7f]/.test(value)) {
		throw new Error("The URL is invalid or too long");
	}
	let url: URL;
	try {
		url = base ? new URL(value, base) : new URL(value);
	} catch {
		throw new Error("The URL is invalid");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only HTTP and HTTPS URLs are supported");
	}
	if (url.username || url.password) throw new Error("URLs containing credentials are not allowed");
	return url;
}

export async function resolvePublicUrl(value: string | URL): Promise<{ url: URL; addresses: string[] }> {
	const url = typeof value === "string" ? parseWebUrl(value) : parseWebUrl(value.toString());
	const host = url.hostname.startsWith("[") && url.hostname.endsWith("]")
		? url.hostname.slice(1, -1)
		: url.hostname;
	let addresses: string[];
	try {
		addresses = isIP(host)
			? [host]
			: (await lookup(host, { all: true, verbatim: true })).map(({ address }) => address);
	} catch {
		throw new Error("The URL host could not be resolved safely");
	}
	if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
		throw new BlockedHostError(
			"Private, loopback, link-local, multicast, reserved, and unresolved hosts are not allowed",
			isIP(host) !== 0,
		);
	}
	return { url, addresses: [...new Set(addresses)] };
}

function curlResolveArgs(url: URL, addresses: string[]): string[] {
	const port = url.port || (url.protocol === "https:" ? "443" : "80");
	const host = url.hostname.startsWith("[") && url.hostname.endsWith("]")
		? url.hostname.slice(1, -1)
		: url.hostname;
	if (isIP(host)) return [];
	const pinnedAddresses = addresses.map((address) => isIP(address) === 6 ? `[${address}]` : address);
	// Pin the DNS results in curl itself so a DNS-rebinding race cannot swap the address afterwards.
	return ["--resolve", `${host}:${port}:${pinnedAddresses.join(",")}`];
}

export function displayUrl(value: string | URL): string {
	try {
		const raw = typeof value === "string" ? value : value.toString();
		const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
		url.username = "";
		url.password = "";
		url.hash = "";
		if (url.search) url.search = "?…";
		return url.toString().replace(/[\0-\x1f\x7f]/g, "");
	} catch {
		return "invalid-url";
	}
}

export function sanitizeResultUrl(value: string): string | undefined {
	try {
		const url = parseWebUrl(value);
		url.username = "";
		url.password = "";
		url.hash = "";
		return url.toString().replace(/[\0-\x1f\x7f]/g, "").slice(0, MAX_URL_LENGTH);
	} catch {
		return undefined;
	}
}

export function sanitizeMessage(value: string): string {
	return value
		.replace(/https?:\/\/[^\s<>"']+/gi, (url) => displayUrl(url))
		.replace(/[\0-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 300);
}

function parseCurlVersion(value: string): [number, number, number] | undefined {
	const match = value.match(/^curl (\d+)\.(\d+)\.(\d+)(?:\s|$)/m);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function isVersionAtLeast(actual: readonly number[], required: readonly number[]): boolean {
	for (let index = 0; index < required.length; index++) {
		if ((actual[index] ?? 0) !== (required[index] ?? 0)) return (actual[index] ?? 0) > (required[index] ?? 0);
	}
	return true;
}

export interface CurlResponse {
	body: string;
	status: number;
	location?: string;
}

const CURL_META_MARKER = "__PI_WEB_CURL_META__";

function parseCurlMetadata(stderr: string): { status: number; location?: string } {
	const markerIndex = stderr.lastIndexOf(CURL_META_MARKER);
	if (markerIndex < 0) throw new Error("The server returned an invalid HTTP response");
	try {
		const metadata = JSON.parse(stderr.slice(markerIndex + CURL_META_MARKER.length)) as {
			http_code?: unknown;
			redirect_url?: unknown;
		};
		if (typeof metadata.http_code !== "number") throw new Error("invalid status");
		if (metadata.redirect_url !== undefined && metadata.redirect_url !== null && typeof metadata.redirect_url !== "string") {
			throw new Error("invalid redirect URL");
		}
		return {
			status: metadata.http_code,
			location: typeof metadata.redirect_url === "string" && metadata.redirect_url.length > 0
				? metadata.redirect_url
				: undefined,
		};
	} catch {
		throw new Error("The server returned invalid HTTP metadata");
	}
}

function commonCurlArgs(protocols: "=https" | "=http,https", maxBytes: number, timeoutMs: number): string[] {
	return [
		"--disable", "--silent", "--show-error", "--globoff", "--fail-with-body",
		// Neutralize every ambient proxy source so the SSRF validation above cannot be bypassed.
		"--proxy", "", "--noproxy", "*",
		"--proto", protocols, "--proto-redir", protocols,
		"--max-time", String(Math.ceil(timeoutMs / 1000)), "--max-filesize", String(maxBytes),
		"--user-agent", UA,
	];
}

export async function ensureCurlVersion(pi: ExtensionAPI): Promise<void> {
	let result: Awaited<ReturnType<ExtensionAPI["exec"]>>;
	try {
		result = await pi.exec("curl", ["--disable", "--version"], { timeout: 5000 });
	} catch {
		throw new Error("A supported curl is required (install curl 8.4.0 or newer and ensure it is on PATH)");
	}
	const version = result.code === 0 ? parseCurlVersion(result.stdout) : undefined;
	if (!version || !isVersionAtLeast(version, MIN_CURL_VERSION)) {
		const found = version ? version.join(".") : "unknown";
		throw new Error(`A supported curl is required (found ${found}; install curl 8.4.0 or newer)`);
	}
}

async function curlRequest(
	pi: ExtensionAPI,
	url: URL,
	addresses: string[],
	protocols: "=https" | "=http,https",
	maxBytes: number,
	signal: AbortSignal | undefined,
	options: RequestOptions,
): Promise<CurlResponse> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const result = await pi.exec("curl", [
		...commonCurlArgs(protocols, maxBytes, timeoutMs),
		...curlResolveArgs(url, addresses),
		...(options.extraArgs ?? []),
		"--output", "-", "--write-out", `%{stderr}${CURL_META_MARKER}%{json}`, "--url", url.toString(),
	], { signal, timeout: timeoutMs + 5000 });
	if (result.code !== 0) {
		const detail = sanitizeMessage(result.stderr) || "transfer error";
		const message = `Request failed (curl exit ${result.code}): ${detail}`;
		if (result.killed || TRANSPORT_EXIT_CODES.has(result.code)) throw new TransportError(message);
		throw new Error(message);
	}
	if (Buffer.byteLength(result.stdout) > maxBytes) {
		throw new Error("Request failed: response exceeded the transfer limit");
	}
	return { body: result.stdout, ...parseCurlMetadata(result.stderr) };
}

export async function fetchPublic(
	pi: ExtensionAPI,
	initialUrl: URL,
	protocols: "=https" | "=http,https",
	maxBytes: number,
	signal: AbortSignal | undefined,
	options: RequestOptions = {},
): Promise<{ body: string; url: URL }> {
	let current = initialUrl;
	for (let redirects = 0; ; redirects++) {
		const resolved = await resolvePublicUrl(current);
		const response = await curlRequest(pi, resolved.url, resolved.addresses, protocols, maxBytes, signal, options);
		if (![301, 302, 303, 307, 308].includes(response.status)) {
			return { body: response.body, url: resolved.url };
		}
		if (!response.location) throw new Error("The server returned a redirect without a Location header");
		if (redirects >= MAX_REDIRECTS) throw new Error(`Too many redirects (maximum ${MAX_REDIRECTS})`);
		const next = parseWebUrl(response.location, resolved.url);
		if (protocols === "=https" && next.protocol !== "https:") {
			throw new Error("Redirects must remain on HTTPS");
		}
		if (resolved.url.protocol === "https:" && next.protocol === "http:") {
			throw new Error("HTTPS-to-HTTP redirects are not allowed");
		}
		current = next;
	}
}
