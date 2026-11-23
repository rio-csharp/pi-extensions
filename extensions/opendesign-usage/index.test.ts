import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

async function setup(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "opendesign-usage-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	const previousKey = process.env.OPENDESIGN_USAGE_TEST_KEY;
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.OPENDESIGN_USAGE_TEST_KEY = "first-key";
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		if (previousKey === undefined) delete process.env.OPENDESIGN_USAGE_TEST_KEY;
		else process.env.OPENDESIGN_USAGE_TEST_KEY = previousKey;
		rmSync(dir, { recursive: true, force: true });
	});
	const { default: extension } = await import(`./index.ts?${encodeURIComponent(dir)}`) as typeof import("./index.ts");
	const handlers = new Map<string, (event: object, ctx: ExtensionContext) => void>();
	extension({ on: (name: string, handler: (event: object, ctx: ExtensionContext) => void) => handlers.set(name, handler) } as unknown as ExtensionAPI);
	const requests: { url: URL; signal: AbortSignal; reply: (body: unknown, ok?: boolean) => void }[] = [];
	const arrivals = new EventEmitter();
	t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => new Promise<Response>(resolve => {
		requests.push({
			url: new URL(url), signal: init.signal!,
			reply: (body, ok = true) => resolve({ ok, json: async () => body } as Response),
		});
		arrivals.emit("request");
	}));
	return {
		configure: (overrides = {}) => writeFileSync(join(dir, "opendesign-usage.json"), JSON.stringify({
			controlKey: "$OPENDESIGN_USAGE_TEST_KEY", apiUrl: "https://usage.example", ...overrides,
		})),
		async nextRequest() {
			if (!requests.length) await once(arrivals, "request", { signal: AbortSignal.timeout(1500) });
			return requests.shift()!;
		},
		session() {
			const status: (string | undefined)[] = [];
			const manager = {};
			let model = { provider: "amr-link", id: "first" };
			const ctx = () => ({
				mode: "tui", hasUI: true, sessionManager: manager, model,
				ui: { theme: { fg: (_color: string, text: string) => text }, setStatus: (_key: string, text?: string) => status.push(text) },
			} as unknown as ExtensionContext);
			const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx());
			t.after(() => emit("session_shutdown"));
			return {
				status, emit,
				select(id: string) {
					const previousModel = model;
					model = { ...model, id };
					emit("model_select", { model, previousModel });
				},
			};
		},
	};
}

const windows = (remainingCredits: number) => ({ codingPlan: { windows: [{ durationSeconds: 3600, limitCredits: 100, remainingCredits }] } });
const currentPath = "/api/v1/workspaces/current";

test("an older model refresh cannot publish or invalidate the current workspace", async t => {
	const { configure, session, nextRequest } = await setup(t);
	configure();
	const { status, emit, select } = session();
	emit("session_start");
	(await nextRequest()).reply({ activeWorkspaceId: "workspace" });
	const first = await nextRequest();
	assert.equal(first.url.search, "?modelId=first");
	select("second");
	const second = await nextRequest();
	assert.equal(second.url.search, "?modelId=second");
	assert.equal(first.signal.aborted, true);
	second.reply(windows(80));
	await setImmediate();
	first.reply(undefined, false);
	await setImmediate();
	assert.equal(status.at(-1), "1h:80%");
	select("third");
	const third = await nextRequest();
	assert.equal(third.url.pathname, "/api/v1/workspaces/workspace/billing/preflight");
	select("first");
	const latest = await nextRequest();
	latest.reply(windows(90));
	await setImmediate();
	third.reply(windows(20));
	await setImmediate();
	assert.equal(status.at(-1), "1h:90%");
});

test("shutdown discards a pending workspace discovery from the old session", async t => {
	const { configure, session, nextRequest } = await setup(t);
	configure();
	const old = session();
	old.emit("session_start");
	const oldDiscovery = await nextRequest();
	old.emit("session_shutdown");
	const replacement = session();
	replacement.emit("session_start");
	const discovery = await nextRequest();
	assert.equal(discovery.url.pathname, currentPath);
	assert.equal(oldDiscovery.signal.aborted, true);
	oldDiscovery.reply({ activeWorkspaceId: "old" });
	discovery.reply({ activeWorkspaceId: "replacement" });
	const preflight = await nextRequest();
	assert.equal(preflight.url.pathname, "/api/v1/workspaces/replacement/billing/preflight");
	preflight.reply(windows(70));
	await setImmediate();
	assert.deepEqual(old.status, [undefined]);
	assert.deepEqual(replacement.status, ["1h:70%"]);
});

test("workspace cache follows effective credentials, API URL, and workspace override", async t => {
	const { configure, session, nextRequest } = await setup(t);
	const { emit, select } = session();
	configure();
	emit("session_start");
	async function respond(workspace: string, discover: boolean, origin = "https://usage.example") {
		if (discover) {
			const current = await nextRequest();
			assert.equal(current.url.href, `${origin}${currentPath}`);
			current.reply({ activeWorkspaceId: workspace });
		}
		const preflight = await nextRequest();
		assert.equal(preflight.url.href.split("?")[0], `${origin}/api/v1/workspaces/${workspace}/billing/preflight`);
		preflight.reply(windows(100));
		await setImmediate();
	}
	await respond("initial", true);
	configure({ apiUrl: "https://usage.example/", providers: [" amr-link ", "amr-link"] });
	select("equivalent");
	await respond("initial", false);
	process.env.OPENDESIGN_USAGE_TEST_KEY = "rotated-key";
	select("key-changed");
	await respond("rotated", true);
	configure({ apiUrl: "https://other.example" });
	select("url-changed");
	await respond("other", true, "https://other.example");
	configure({ workspaceId: "fixed" });
	select("override-added");
	await respond("fixed", false);
	configure();
	select("override-removed");
	await respond("rediscovered", true);
});
