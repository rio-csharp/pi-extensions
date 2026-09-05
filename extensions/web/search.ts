import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WebConfig } from "./config.ts";
import { createBingProvider } from "./providers/bing.ts";
import { createDuckDuckGoProvider } from "./providers/duckduckgo.ts";
import type { SearchProvider, SearchRequest, SearchResultItem } from "./providers/provider.ts";
import { createSearxngProvider } from "./providers/searxng.ts";
import { fetchPublic, parseWebUrl } from "./transport.ts";

const SEARCH_TRANSFER_BYTES = 2 * 1024 * 1024;
const SEARCH_ATTEMPT_TIMEOUT_MS = 12_000;
const MAX_FAILURE_NOTES = 6;

export function resolveSearchProviders(config: WebConfig): SearchProvider[] {
	return config.searchProviders.map((entry) => {
		if (entry === "duckduckgo") return createDuckDuckGoProvider();
		if (entry === "bing") return createBingProvider();
		return createSearxngProvider(entry);
	});
}

export type SearchFetch = (request: SearchRequest) => Promise<{ body: string }>;

export interface SearchOutcome {
	items: SearchResultItem[];
	providerId?: string;
}

// The first provider that works wins for the rest of the session; a later transport failure re-walks the chain.
let cachedProviderId: string | undefined;

export function resetSearchProviderCache(): void {
	cachedProviderId = undefined;
}

export async function runSearch(
	pi: ExtensionAPI,
	providers: SearchProvider[],
	query: string,
	limit: number,
	signal: AbortSignal | undefined,
	searchFetch?: SearchFetch,
): Promise<SearchOutcome> {
	const doFetch: SearchFetch = searchFetch ?? (async (request) => {
		const fetched = await fetchPublic(pi, parseWebUrl(request.url), request.allowHttp ? "=http,https" : "=https", SEARCH_TRANSFER_BYTES, signal, {
			timeoutMs: SEARCH_ATTEMPT_TIMEOUT_MS,
			extraArgs: request.extraArgs,
		});
		return { body: fetched.body };
	});

	const ordered = [...providers].sort((a, b) => {
		if (a.id === cachedProviderId) return -1;
		if (b.id === cachedProviderId) return 1;
		return 0;
	});

	const failures: string[] = [];
	let emptyProviderId: string | undefined;
	for (const provider of ordered) {
		try {
			const { body } = await doFetch(provider.buildRequest(query, limit));
			const items = provider.parseResults(body, limit);
			if (items.length === 0) {
				// Zero parsed rows means either a genuine no-hit or a broken parser/page; try the next provider either way.
				emptyProviderId = provider.id;
				failures.push(`${provider.id}: no parseable results`);
				continue;
			}
			cachedProviderId = provider.id;
			return { items, providerId: provider.id };
		} catch (error) {
			if (signal?.aborted) throw error;
			if (provider.id === cachedProviderId) cachedProviderId = undefined;
			failures.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	if (emptyProviderId && failures.every((note) => note.endsWith("no parseable results"))) {
		return { items: [] };
	}
	const notes = failures.slice(0, MAX_FAILURE_NOTES).join("; ");
	throw new Error(`All search providers failed: ${notes}`);
}
