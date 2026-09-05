import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SearchProvider } from "./providers/provider.ts";
import { resetSearchProviderCache, runSearch } from "./search.ts";
import { TransportError } from "./transport.ts";

const pi = null as unknown as ExtensionAPI;

function fakeProvider(id: string): SearchProvider {
	return {
		id,
		buildRequest: () => ({ url: `https://${id}.example/search` }),
		parseResults: (body) => body === "empty" ? [] : [{ url: "https://r.example/", title: "t", snippet: "s" }],
	};
}

test("falls back to the next provider on transport failure and caches the winner", async () => {
	resetSearchProviderCache();
	const calls: string[] = [];
	const fetch = async ({ url }: { url: string }) => {
		calls.push(url);
		if (url.includes("ddg")) throw new TransportError("Request failed (curl exit 28): timeout");
		return { body: "ok" };
	};
	const providers = [fakeProvider("ddg"), fakeProvider("bing")];

	const first = await runSearch(pi, providers, "q", 8, undefined, fetch);
	assert.equal(first.providerId, "bing");
	assert.deepEqual(calls, ["https://ddg.example/search", "https://bing.example/search"]);

	calls.length = 0;
	const second = await runSearch(pi, providers, "q", 8, undefined, fetch);
	assert.equal(second.providerId, "bing");
	assert.deepEqual(calls, ["https://bing.example/search"]);
});

test("tries the next provider when one returns no parseable results", async () => {
	resetSearchProviderCache();
	const fetch = async ({ url }: { url: string }) => ({ body: url.includes("ddg") ? "empty" : "ok" });
	const outcome = await runSearch(pi, [fakeProvider("ddg"), fakeProvider("bing")], "q", 8, undefined, fetch);
	assert.equal(outcome.providerId, "bing");
	assert.equal(outcome.items.length, 1);
});

test("returns empty items only when every provider answered but parsed nothing", async () => {
	resetSearchProviderCache();
	const fetch = async () => ({ body: "empty" });
	const outcome = await runSearch(pi, [fakeProvider("ddg"), fakeProvider("bing")], "q", 8, undefined, fetch);
	assert.deepEqual(outcome, { items: [] });
});

test("throws a combined error when every provider hard-fails", async () => {
	resetSearchProviderCache();
	const fetch = async () => { throw new TransportError("Request failed (curl exit 6): could not resolve"); };
	await assert.rejects(
		runSearch(pi, [fakeProvider("ddg"), fakeProvider("bing")], "q", 8, undefined, fetch),
		/All search providers failed: ddg: .*; bing: /,
	);
});

test("rethrows immediately when the abort signal fires", async () => {
	resetSearchProviderCache();
	const controller = new AbortController();
	controller.abort();
	const fetch = async () => { throw new Error("aborted"); };
	await assert.rejects(
		runSearch(pi, [fakeProvider("ddg"), fakeProvider("bing")], "q", 8, controller.signal, fetch),
		/^Error: aborted$/,
	);
});
