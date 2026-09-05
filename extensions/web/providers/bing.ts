import { sanitizeResultUrl } from "../transport.ts";
import { decodeEntities, sanitizeContentText, stripTags } from "../text.ts";
import type { SearchProvider, SearchResultItem } from "./provider.ts";

// Bing wraps result links in a /ck/a tracking redirect; the real URL is base64url in the u= param after an "a1" marker.
function decodeBingRedirect(href: string): string {
	try {
		const url = new URL(href);
		if ((url.hostname === "www.bing.com" || url.hostname === "bing.com") && url.pathname === "/ck/a") {
			const wrapped = url.searchParams.get("u");
			if (wrapped?.startsWith("a1")) {
				const decoded = Buffer.from(wrapped.slice(2), "base64url").toString("utf8");
				if (/^https?:\/\//i.test(decoded)) return decoded;
			}
		}
	} catch { /* fall through */ }
	return href;
}

export function createBingProvider(): SearchProvider {
	return {
		id: "bing",
		buildRequest(query, limit) {
			return { url: `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${limit}` };
		},
		parseResults(html, limit): SearchResultItem[] {
			const items: SearchResultItem[] = [];
			const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
			for (const block of blocks) {
				if (items.length >= limit) break;
				const link = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
				if (!link) continue;
				const target = sanitizeResultUrl(decodeBingRedirect(decodeEntities(link[1])));
				if (!target) continue;
				const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
				items.push({
					url: target,
					title: sanitizeContentText(stripTags(link[2]), 500),
					snippet: snippet ? sanitizeContentText(stripTags(snippet[1]), 2000) : "",
				});
			}
			return items;
		},
	};
}
