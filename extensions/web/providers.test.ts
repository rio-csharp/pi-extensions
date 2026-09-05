import assert from "node:assert/strict";
import test from "node:test";
import { createBingProvider } from "./providers/bing.ts";
import { createDuckDuckGoProvider } from "./providers/duckduckgo.ts";
import { createSearxngProvider } from "./providers/searxng.ts";

test("duckduckgo parses uddg-wrapped and direct result links", () => {
	const provider = createDuckDuckGoProvider();
	const html = `
		<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example <b>Docs</b></a>
		<a class="result__snippet" href="x">A documentation <b>snippet</b>.</a>
		<a class="result__a" href="https://direct.example.com/page">Direct &amp; Page</a>
		<a class="result__snippet" href="y">Second snippet.</a>`;
	const items = provider.parseResults(html, 8);
	assert.deepEqual(items, [
		{ url: "https://example.com/docs", title: "Example Docs", snippet: "A documentation snippet." },
		{ url: "https://direct.example.com/page", title: "Direct & Page", snippet: "Second snippet." },
	]);
});

test("bing parses b_algo blocks and decodes ck/a tracking redirects", () => {
	const provider = createBingProvider();
	const wrapped = `a1${Buffer.from("https://real.example.com/guide").toString("base64url")}`;
	const html = `
		<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=${wrapped}&amp;p=1">Real <b>Guide</b></a></h2>
		<div class="b_caption"><p>A guide snippet &amp; more.</p></div></li>
		<li class="b_algo"><h2><a href="https://plain.example.com/">Plain</a></h2></li>
		<li class="b_algo"><h2><a href="javascript:evil()">Bad</a></h2></li>`;
	const items = provider.parseResults(html, 8);
	assert.deepEqual(items, [
		{ url: "https://real.example.com/guide", title: "Real Guide", snippet: "A guide snippet & more." },
		{ url: "https://plain.example.com/", title: "Plain", snippet: "" },
	]);
});

test("searxng builds a json search URL with optional basic auth", () => {
	const anon = createSearxngProvider({ id: "searxng", endpoint: "https://searx.example.com/" });
	const request = anon.buildRequest("hello world", 5);
	assert.equal(request.url, "https://searx.example.com/search?q=hello+world&format=json");
	assert.equal(request.extraArgs, undefined);

	const authed = createSearxngProvider({ id: "searxng", endpoint: "https://searx.example.com", basicAuth: "u:p" });
	assert.deepEqual(authed.buildRequest("q", 5).extraArgs, ["--user", "u:p"]);
});

test("searxng parses results and drops invalid entries", () => {
	const provider = createSearxngProvider({ id: "searxng", endpoint: "https://searx.example.com/" });
	const body = JSON.stringify({
		results: [
			{ url: "https://example.com/a", title: "A", content: "alpha" },
			{ url: "javascript:evil()", title: "bad" },
			{ title: "no url" },
			{ url: "https://example.com/b", title: "B" },
		],
	});
	assert.deepEqual(provider.parseResults(body, 8), [
		{ url: "https://example.com/a", title: "A", snippet: "alpha" },
		{ url: "https://example.com/b", title: "B", snippet: "" },
	]);
	assert.deepEqual(provider.parseResults("not json", 8), []);
});
