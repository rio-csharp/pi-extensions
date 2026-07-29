import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import webExtension from "./index.ts";

type Tool = {
	name: string;
	execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<any>;
};

type Response = { status?: number; location?: string; body?: string; stderr?: string; code?: number };

function createHarness(responses: Response[] = [], curlVersion = "curl 8.4.0 test") {
	const tools = new Map<string, Tool>();
	const transferArgs: string[][] = [];
	const queue = [...responses];
	const pi = {
		registerTool(tool: Tool) {
			tools.set(tool.name, tool);
		},
		on() {},
		async exec(command: string, args: string[]) {
			assert.equal(command, "curl");
			if (args.includes("--version")) return { stdout: `${curlVersion}\n`, stderr: "", code: 0, killed: false };
			transferArgs.push(args);
			const response = queue.shift() ?? { status: 200, body: "<title>ok</title><p>body</p>" };
			const metadata = JSON.stringify({
				http_code: response.status ?? 200,
				redirect_url: response.location ?? null,
			});
			return {
				stdout: response.body ?? "",
				stderr: response.code && response.code !== 0
					? response.stderr ?? ""
					: `${response.stderr ?? ""}__PI_WEB_CURL_META__${metadata}`,
				code: response.code ?? 0,
				killed: false,
			};
		},
	} as unknown as ExtensionAPI;
	webExtension(pi);
	const fetch = tools.get("web_fetch");
	assert(fetch);
	return { fetch, transferArgs };
}

async function expectReject(fetch: Tool, url: string, pattern: RegExp) {
	await assert.rejects(fetch.execute("test", { url }), pattern);
}

test("allows public IPv4 and IPv6 literals but rejects non-public address ranges", async () => {
	for (const url of ["http://8.8.8.8/", "http://[2606:4700:4700::1111]/"]) {
		const { fetch, transferArgs } = createHarness();
		await fetch.execute("test", { url });
		assert.equal(transferArgs.length, 1);
	}
	for (const url of [
		"http://127.0.0.1/", "http://169.254.169.254/", "http://192.168.1.1/",
		"http://[::1]/", "http://[fc00::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/",
	]) {
		const { fetch, transferArgs } = createHarness();
		await expectReject(fetch, url, /hosts are not allowed/);
		assert.equal(transferArgs.length, 0);
	}
});

test("manually follows a public redirect and validates every destination", async () => {
	const { fetch, transferArgs } = createHarness([
		{ status: 302, location: "http://1.1.1.1/docs" },
		{ status: 200, body: "<p>documentation</p>" },
	]);
	const result = await fetch.execute("test", { url: "http://8.8.8.8/start" });
	assert.equal(transferArgs.length, 2);
	assert.match(result.content[0].text, /^http:\/\/1\.1\.1\.1\/docs/);
});

test("rejects redirect to private, non-HTTP, and HTTPS downgrade destinations", async () => {
	for (const [start, location, pattern] of [
		["http://8.8.8.8/", "http://127.0.0.1/secret", /hosts are not allowed/],
		["http://8.8.8.8/", "file:///etc/passwd", /Only HTTP and HTTPS/],
		["https://8.8.8.8/", "http://1.1.1.1/", /HTTPS-to-HTTP/],
	] as const) {
		const { fetch, transferArgs } = createHarness([{ status: 302, location }]);
		await expectReject(fetch, start, pattern);
		assert.equal(transferArgs.length, 1);
	}
});

test("puts curlrc disable first and explicitly disables every proxy source", async () => {
	const { fetch, transferArgs } = createHarness();
	await fetch.execute("test", { url: "http://8.8.8.8/" });
	const args = transferArgs[0]!;
	assert.equal(args[0], "--disable");
	assert.deepEqual(args.slice(args.indexOf("--proxy"), args.indexOf("--proxy") + 2), ["--proxy", ""]);
	assert.deepEqual(args.slice(args.indexOf("--noproxy"), args.indexOf("--noproxy") + 2), ["--noproxy", "*"]);
	assert.deepEqual(args.slice(args.indexOf("--proto-redir"), args.indexOf("--proto-redir") + 2), ["--proto-redir", "=http,https"]);
	assert(args.includes("--resolve") === false, "literal IP needs no DNS override");
});

test("pins every validated DNS answer for a public hostname", async () => {
	const { fetch, transferArgs } = createHarness();
	await fetch.execute("test", { url: "http://example.com/" });
	const args = transferArgs[0]!;
	const resolveIndex = args.indexOf("--resolve");
	assert.notEqual(resolveIndex, -1);
	assert.match(args[resolveIndex + 1]!, /^example\.com:80:(?:\[[0-9a-f:]+\]|\d+\.\d+\.\d+\.\d+)(?:,(?:\[[0-9a-f:]+\]|\d+\.\d+\.\d+\.\d+))*$/i);
});

test("rejects curl older than 8.4 before transfer with an actionable error", async () => {
	const { fetch, transferArgs } = createHarness([], "curl 8.3.0 test");
	await expectReject(fetch, "http://8.8.8.8/", /install curl 8\.4\.0 or newer/);
	assert.equal(transferArgs.length, 0);
});

test("enforces a hard post-exec transfer cap as defense in depth", async () => {
	const { fetch } = createHarness([{ status: 200, body: "x".repeat(2 * 1024 * 1024 + 1) }]);
	await expectReject(fetch, "http://8.8.8.8/", /exceeded the transfer limit/);
});

test("sanitizes credentials and query strings from failures", async () => {
	const credentialsHarness = createHarness();
	await expectReject(credentialsHarness.fetch, "http://user:secret@8.8.8.8/path?token=secret", /credentials are not allowed/);
	const failureHarness = createHarness([{
		code: 7,
		stderr: "curl: failed http://8.8.8.8/path?token=secret\nINJECTED",
	}]);
	try {
		await failureHarness.fetch.execute("test", { url: "http://8.8.8.8/path?token=secret" });
		assert.fail("expected transfer failure");
	} catch (error) {
		assert.doesNotMatch(String(error), /token=secret|\nINJECTED/);
	}
});
