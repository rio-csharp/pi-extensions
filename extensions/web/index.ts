import {
	DEFAULT_MAX_BYTES,
	type ExtensionAPI,
	type ExtensionContext,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createCompactRenderer } from "./compact-tool-renderer.ts";
import { loadWebConfig } from "./config.ts";
import { resolveSearchProviders, runSearch } from "./search.ts";
import { BlockedHostError, TransportError, displayUrl, ensureCurlVersion, fetchPublic, parseWebUrl, sanitizeMessage } from "./transport.ts";
import { htmlToText, sanitizeContentText, stripTags } from "./text.ts";

const MAX_FETCH_BYTES = 1024 * 1024;
const MAX_TRANSFER_BYTES = 2 * 1024 * 1024;

const shownWarnings = new Set<string>();

function notifyConfigWarnings(ctx: ExtensionContext | undefined, warnings: string[]): void {
	if (!ctx?.hasUI) return;
	for (const warning of warnings) {
		if (shownWarnings.has(warning)) continue;
		shownWarnings.add(warning);
		ctx.ui.notify(warning, "warning");
	}
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
			"Search the web via configurable providers (DuckDuckGo and Bing by default; self-hosted SearXNG supported). Returns a ranked list of titles, URLs, and snippets. Providers are tried in the configured order until one answers.",
		promptSnippet: "Search the web for documentation and sources to verify facts",
		promptGuidelines: [
			"Use web_search to find official docs/specs/RFCs when verifying version-sensitive, security, performance, or API claims.",
			"After web_search, use web_fetch to read the most authoritative result before relying on it.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 15, description: "Max results (default 8)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			await ensureCurlVersion(pi);
			const config = loadWebConfig();
			notifyConfigWarnings(ctx, config.warnings);
			const limit = params.limit ?? 8;
			let outcome: Awaited<ReturnType<typeof runSearch>>;
			try {
				outcome = await runSearch(pi, resolveSearchProviders(config), params.query, limit, signal);
			} catch (error) {
				throw new Error(`web_search failed: ${sanitizeMessage(error instanceof Error ? error.message : String(error))}`);
			}
			if (outcome.items.length === 0) {
				return {
					content: [{ type: "text", text: `No results for: ${sanitizeContentText(params.query, 1000)}` }],
					details: { query: params.query, results: [] },
				};
			}
			const text = outcome.items
				.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
				.join("\n\n");
			return {
				content: [{ type: "text", text }],
				details: { query: params.query, results: outcome.items, provider: outcome.providerId },
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
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			await ensureCurlVersion(pi);
			const config = loadWebConfig();
			notifyConfigWarnings(ctx, config.warnings);
			let requestedUrl = params.url.trim().replace(/^@/, "");
			if (!/^https?:\/\//i.test(requestedUrl)) requestedUrl = `https://${requestedUrl}`;
			let fetched: { body: string; url: URL };
			let via = "direct";
			try {
				fetched = await fetchPublic(pi, parseWebUrl(requestedUrl), "=http,https", MAX_TRANSFER_BYTES, signal);
			} catch (directError) {
				const relay = config.fetchRelay;
				const relayable = directError instanceof TransportError
					|| (directError instanceof BlockedHostError && !directError.literalIp);
				if (!relayable || !relay || signal?.aborted) {
					throw new Error(`web_fetch failed: ${sanitizeMessage(directError instanceof Error ? directError.message : String(directError))}`);
				}
				try {
					const relayUrl = new URL(relay.endpoint);
					relayUrl.searchParams.set("url", parseWebUrl(requestedUrl).toString());
					const relayed = await fetchPublic(pi, relayUrl, "=https", MAX_TRANSFER_BYTES, signal, {
						extraArgs: ["-H", `Authorization: Bearer ${relay.token}`],
					});
					fetched = { body: relayed.body, url: parseWebUrl(requestedUrl) };
					via = "relay";
				} catch (relayError) {
					const directMessage = sanitizeMessage(directError.message);
					const relayMessage = sanitizeMessage(relayError instanceof Error ? relayError.message : String(relayError));
					throw new Error(`web_fetch failed: ${directMessage}; relay failed: ${relayMessage}`);
				}
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
				details: { url, title, truncated: trunc.truncated, via },
			};
		},
	});

	pi.on("session_shutdown", () => {
		for (const renderer of compactRenderers) renderer.dispose();
	});
}
