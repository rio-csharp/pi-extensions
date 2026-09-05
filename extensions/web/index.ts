import {
	DEFAULT_MAX_BYTES,
	type ExtensionAPI,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { createCompactRenderer } from "./compact-tool-renderer.ts";

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_FETCH_BYTES = 1024 * 1024;
const MAX_TRANSFER_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_TRANSFER_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_URL_LENGTH = 8192;
const REQUEST_TIMEOUT_MS = 30_000;
const MIN_CURL_VERSION = [8, 4, 0] as const;

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

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#0*39;/g, "'")
		.replace(/&#x0*27;/gi, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(parseInt(n, 10)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_m, n: string) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/[ \t\r\f\v]+/g, " ").trim();
}

function sanitizeContentText(value: string, maxLength = 2000): string {
	return value.replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").slice(0, maxLength);
}

function isPrivateAddress(address: string): boolean {
	const normalized = address.toLowerCase().split("%")[0];
	const family = isIP(normalized);
	if (family === 4) return blockedIpv4.check(normalized, "ipv4");
	if (family === 6) return blockedIpv6.check(normalized, "ipv6");
	return true;
}

function parseWebUrl(value: string, base?: URL): URL {
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

async function resolvePublicUrl(value: string | URL): Promise<{ url: URL; addresses: string[] }> {
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
		throw new Error("Private, loopback, link-local, multicast, reserved, and unresolved hosts are not allowed");
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

function displayUrl(value: string | URL): string {
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

function sanitizeResultUrl(value: string): string | undefined {
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

function sanitizeMessage(value: string): string {
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

interface CurlResponse {
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

function commonCurlArgs(protocols: "=https" | "=http,https", maxBytes: number): string[] {
	return [
		"--disable", "--silent", "--show-error", "--globoff", "--fail-with-body",
		"--proxy", "", "--noproxy", "*", "--proto", protocols, "--proto-redir", protocols,
		"--max-time", String(REQUEST_TIMEOUT_MS / 1000), "--max-filesize", String(maxBytes),
		"--user-agent", UA,
	];
}

async function ensureCurlVersion(pi: ExtensionAPI): Promise<void> {
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
): Promise<CurlResponse> {
	const result = await pi.exec("curl", [
		...commonCurlArgs(protocols, maxBytes), ...curlResolveArgs(url, addresses),
		"--output", "-", "--write-out", `%{stderr}${CURL_META_MARKER}%{json}`, "--url", url.toString(),
	], { signal, timeout: REQUEST_TIMEOUT_MS + 5000 });
	if (result.code !== 0) {
		throw new Error(`Request failed (curl exit ${result.code}): ${sanitizeMessage(result.stderr) || "transfer error"}`);
	}
	if (Buffer.byteLength(result.stdout) > maxBytes) {
		throw new Error("Request failed: response exceeded the transfer limit");
	}
	return { body: result.stdout, ...parseCurlMetadata(result.stderr) };
}

async function fetchPublic(
	pi: ExtensionAPI,
	initialUrl: URL,
	protocols: "=https" | "=http,https",
	maxBytes: number,
	signal: AbortSignal | undefined,
): Promise<{ body: string; url: URL }> {
	let current = initialUrl;
	for (let redirects = 0; ; redirects++) {
		const resolved = await resolvePublicUrl(current);
		const response = await curlRequest(pi, resolved.url, resolved.addresses, protocols, maxBytes, signal);
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

function htmlToText(html: string): string {
	let text = html;
	text = text.replace(/<!--[\s\S]*?-->/g, " ");
	text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
	text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
	text = text.replace(/<head[\s\S]*?<\/head>/gi, " ");
	text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
	text = text.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
	text = text.replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote)>/gi, "\n");
	text = text.replace(/<(br|hr)\s*\/?>/gi, "\n");
	text = text.replace(/<li[^>]*>/gi, "- ");
	text = decodeEntities(text.replace(/<[^>]+>/g, ""));
	text = text.replace(/[ \t\f\v]+/g, " ");
	text = text.replace(/ *\n */g, "\n");
	text = text.replace(/\n{3,}/g, "\n\n");
	return text.trim();
}

export default function (pi: ExtensionAPI) {
	const compactRenderers: Array<{ dispose(): void }> = [];
	const searchRenderer = createCompactRenderer("web_search", (args) => {
		const query = typeof args.query === "string" && args.query.length > 0 ? JSON.stringify(args.query) : "...";
		return args.limit === undefined ? query : `${query} · limit=${args.limit}`;
	});
	const fetchRenderer = createCompactRenderer("web_fetch", (args) => {
		const url = typeof args.url === "string" && args.url.length > 0 ? displayUrl(args.url) : "...";
		return args.maxBytes === undefined ? url : `${url} · maxBytes=${args.maxBytes}`;
	});
	compactRenderers.push(searchRenderer, fetchRenderer);

	pi.registerTool({
		name: "web_search",
		renderShell: searchRenderer.renderShell,
		renderCall: searchRenderer.renderCall,
		renderResult: searchRenderer.renderResult,
		label: "Web Search",
		description:
			"Search the web via DuckDuckGo (no API key). Returns a ranked list of titles, URLs, and snippets. HTTPS redirects are followed only after each destination is resolved, validated, and DNS-pinned.",
		promptSnippet: "Search the web for documentation and sources to verify facts",
		promptGuidelines: [
			"Use web_search to find official docs/specs/RFCs when verifying version-sensitive, security, performance, or API claims.",
			"After web_search, use web_fetch to read the most authoritative result before relying on it.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 15, description: "Max results (default 8)" })),
		}),
		async execute(_toolCallId, params, signal) {
			await ensureCurlVersion(pi);
			const limit = params.limit ?? 8;
			const initialUrl = parseWebUrl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(params.query)}`);
			let fetched: { body: string; url: URL };
			try {
				fetched = await fetchPublic(pi, initialUrl, "=https", MAX_SEARCH_TRANSFER_BYTES, signal);
			} catch (error) {
				throw new Error(`web_search failed: ${sanitizeMessage(error instanceof Error ? error.message : String(error))}`);
			}
			const html = fetched.body;
			const titles: { url: string; title: string }[] = [];
			const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
			let m: RegExpExecArray | null;
			while ((m = linkRe.exec(html)) && titles.length < limit) {
				const href = m[1];
				const uddg = href.match(/[?&]uddg=([^&]+)/);
				let target: string;
				try {
					target = uddg ? decodeURIComponent(uddg[1]) : href;
				} catch {
					continue;
				}
				if (target.startsWith("//")) target = `https:${target}`;
				const safeTarget = sanitizeResultUrl(target);
				if (safeTarget) titles.push({ url: safeTarget, title: sanitizeContentText(stripTags(m[2]), 500) });
			}
			const snippets: string[] = [];
			const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
			while ((m = snipRe.exec(html)) && snippets.length < titles.length) {
				snippets.push(sanitizeContentText(stripTags(m[1]), 2000));
			}
			if (titles.length === 0) {
				return {
					content: [{ type: "text", text: `No results for: ${sanitizeContentText(params.query, 1000)}` }],
					details: { query: params.query, results: [] },
				};
			}
			const results = titles.map((t, i) => ({ ...t, snippet: snippets[i] ?? "" }));
			const text = results
				.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
				.join("\n\n");
			return {
				content: [{ type: "text", text }],
				details: { query: params.query, results },
			};
		},
	});

	pi.registerTool({
		name: "web_fetch",
		renderShell: fetchRenderer.renderShell,
		renderCall: fetchRenderer.renderCall,
		renderResult: fetchRenderer.renderResult,
		label: "Web Fetch",
		description:
			"Fetch a public HTTP(S) URL and return readable, tag-stripped text. Follows at most 5 validated, DNS-pinned redirects; HTTPS cannot redirect to HTTP. Transfer size is capped before output truncation.",
		promptSnippet: "Fetch and read a web page as plain text",
		promptGuidelines: ["Use web_fetch to read a source URL before citing it as verification."],
		parameters: Type.Object({
			url: Type.String({ description: "The absolute URL to fetch (http/https)" }),
			maxBytes: Type.Optional(
				Type.Integer({ minimum: 1000, maximum: MAX_FETCH_BYTES, description: "Max bytes of text to return (default ~50KB; max 1MB)" }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			await ensureCurlVersion(pi);
			let requestedUrl = params.url.trim().replace(/^@/, "");
			if (!/^https?:\/\//i.test(requestedUrl)) requestedUrl = `https://${requestedUrl}`;
			let fetched: { body: string; url: URL };
			try {
				fetched = await fetchPublic(pi, parseWebUrl(requestedUrl), "=http,https", MAX_TRANSFER_BYTES, signal);
			} catch (error) {
				throw new Error(`web_fetch failed: ${sanitizeMessage(error instanceof Error ? error.message : String(error))}`);
			}
			const url = displayUrl(fetched.url);
			const titleMatch = fetched.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
			const title = titleMatch ? sanitizeContentText(stripTags(titleMatch[1]), 500) : "";
			const body = sanitizeContentText(htmlToText(fetched.body), MAX_TRANSFER_BYTES);
			const maxBytes = params.maxBytes ?? DEFAULT_MAX_BYTES;
			const trunc = truncateHead(body, { maxBytes, maxLines: 100000 });
			let out = title ? `# ${title}\n${url}\n\n${trunc.content}` : `${url}\n\n${trunc.content}`;
			if (trunc.truncated) {
				out += `\n\n[Truncated: showing ${formatSize(trunc.outputBytes)} of ${formatSize(trunc.totalBytes)}. Refine with a more specific URL or a larger maxBytes.]`;
			}
			return {
				content: [{ type: "text", text: out }],
				details: { url, title, truncated: trunc.truncated },
			};
		},
	});

	pi.on("session_shutdown", () => {
		for (const renderer of compactRenderers) renderer.dispose();
	});
}
