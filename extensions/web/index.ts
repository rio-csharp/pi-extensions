/**
 * Web tools extension
 *
 * Adds two LLM-callable tools backed by `curl` (no API key required):
 *   - web_search: keyless search via DuckDuckGo HTML endpoint
 *   - web_fetch:  fetch a URL and return readable, tag-stripped text
 *
 * Intended so (sub)agents can verify version-sensitive, security,
 * performance, or API facts against official documentation.
 */

import {
	DEFAULT_MAX_BYTES,
	type ExtensionAPI,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createCompactRenderer } from "./compact-tool-renderer.ts";

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

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

function htmlToText(html: string): string {
	let text = html;
	// Drop non-content regions entirely.
	text = text.replace(/<!--[\s\S]*?-->/g, " ");
	text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
	text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
	text = text.replace(/<head[\s\S]*?<\/head>/gi, " ");
	text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
	text = text.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
	// Preserve some block structure as newlines.
	text = text.replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote)>/gi, "\n");
	text = text.replace(/<(br|hr)\s*\/?>/gi, "\n");
	text = text.replace(/<li[^>]*>/gi, "- ");
	text = decodeEntities(text.replace(/<[^>]+>/g, ""));
	// Collapse whitespace but keep line breaks.
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
		const url = typeof args.url === "string" && args.url.length > 0 ? args.url : "...";
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
			"Search the web via DuckDuckGo (no API key). Returns a ranked list of titles, URLs, and snippets. Use to discover official documentation, specs, RFCs, and release notes for facts you need to verify.",
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
			const limit = params.limit ?? 8;
			const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(params.query)}`;
			const res = await pi.exec("curl", ["-sSL", "--max-time", "30", "-A", UA, url], {
				signal,
				timeout: 35000,
			});
			if (res.code !== 0) {
				throw new Error(`web_search failed (curl exit ${res.code}): ${res.stderr.slice(0, 500)}`);
			}
			const html = res.stdout;
			const titles: { url: string; title: string }[] = [];
			const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
			let m: RegExpExecArray | null;
			while ((m = linkRe.exec(html)) && titles.length < limit) {
				let href = m[1];
				const uddg = href.match(/[?&]uddg=([^&]+)/);
				let target = uddg ? decodeURIComponent(uddg[1]) : href;
				if (target.startsWith("//")) target = `https:${target}`;
				titles.push({ url: target, title: stripTags(m[2]) });
			}
			const snippets: string[] = [];
			const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
			while ((m = snipRe.exec(html)) && snippets.length < titles.length) {
				snippets.push(stripTags(m[1]));
			}
			if (titles.length === 0) {
				return {
					content: [{ type: "text", text: `No results for: ${params.query}` }],
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
			"Fetch a URL and return readable, tag-stripped text (no API key). Use to read official documentation, specs, RFCs, and release notes. Output is truncated to ~50KB.",
		promptSnippet: "Fetch and read a web page as plain text",
		promptGuidelines: ["Use web_fetch to read a source URL before citing it as verification."],
		parameters: Type.Object({
			url: Type.String({ description: "The absolute URL to fetch (http/https)" }),
			maxBytes: Type.Optional(
				Type.Integer({ minimum: 1000, description: "Max bytes of text to return (default ~50KB)" }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			let url = params.url.trim().replace(/^@/, "");
			if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
			const res = await pi.exec("curl", ["-sSL", "--max-time", "30", "-A", UA, url], {
				signal,
				timeout: 35000,
			});
			if (res.code !== 0) {
				throw new Error(`web_fetch failed (curl exit ${res.code}): ${res.stderr.slice(0, 500)}`);
			}
			const titleMatch = res.stdout.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
			const title = titleMatch ? stripTags(titleMatch[1]) : "";
			const body = htmlToText(res.stdout);
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
