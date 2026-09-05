import { sanitizeResultUrl } from "../transport.ts";
import { sanitizeContentText, stripTags } from "../text.ts";
import type { SearchProvider, SearchResultItem } from "./provider.ts";

export function createDuckDuckGoProvider(): SearchProvider {
	return {
		id: "duckduckgo",
		buildRequest(query) {
			return { url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}` };
		},
		parseResults(html, limit): SearchResultItem[] {
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
			return titles.map((t, i) => ({ ...t, snippet: snippets[i] ?? "" }));
		},
	};
}
