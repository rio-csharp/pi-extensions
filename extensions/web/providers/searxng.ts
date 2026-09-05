import type { SearxngProviderConfig } from "../config.ts";
import { sanitizeResultUrl } from "../transport.ts";
import { sanitizeContentText } from "../text.ts";
import type { SearchProvider, SearchResultItem } from "./provider.ts";

export function createSearxngProvider(config: SearxngProviderConfig): SearchProvider {
	const base = config.endpoint.endsWith("/") ? config.endpoint : `${config.endpoint}/`;
	return {
		id: "searxng",
		buildRequest(query, limit) {
			const url = new URL("search", base);
			url.searchParams.set("q", query);
			url.searchParams.set("format", "json");
			return {
				url: url.toString(),
				extraArgs: config.basicAuth ? ["--user", config.basicAuth] : undefined,
				allowHttp: url.protocol === "http:",
			};
		},
		parseResults(body, limit): SearchResultItem[] {
			let data: { results?: unknown };
			try {
				data = JSON.parse(body);
			} catch {
				return [];
			}
			if (!Array.isArray(data.results)) return [];
			const items: SearchResultItem[] = [];
			for (const result of data.results) {
				if (items.length >= limit) break;
				const { url, title, content } = result as { url?: unknown; title?: unknown; content?: unknown };
				if (typeof url !== "string") continue;
				const safeUrl = sanitizeResultUrl(url);
				if (!safeUrl) continue;
				items.push({
					url: safeUrl,
					title: sanitizeContentText(typeof title === "string" ? title : "", 500),
					snippet: sanitizeContentText(typeof content === "string" ? content : "", 2000),
				});
			}
			return items;
		},
	};
}
