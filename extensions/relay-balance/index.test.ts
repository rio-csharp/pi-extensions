import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}

async function setup(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "relay-balance-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	});
	writeFileSync(join(dir, "relay-providers.json"), JSON.stringify({
		providers: [{ id: "relay", baseUrl: "https://relay.example/v1", apiKey: "test-key" }],
	}));
	const { default: extension } = await import(`./index.ts?${encodeURIComponent(dir)}`) as typeof import("./index.ts");
	const handlers = new Map<string, (event: object, ctx: ExtensionContext) => void>();
	extension({ on: (name: string, handler: (event: object, ctx: ExtensionContext) => void) => handlers.set(name, handler) } as unknown as ExtensionAPI);
	const requests: { signal: AbortSignal; reply: (remaining: number) => void; reading: Promise<void> }[] = [];
	const arrivals = new EventEmitter();
	t.mock.method(globalThis, "fetch", (_url: URL, init: RequestInit) => {
		const body = deferred<{ remaining: number }>();
		const reading = deferred<void>();
		requests.push({ signal: init.signal!, reply: remaining => body.resolve({ remaining }), reading: reading.promise });
		arrivals.emit("request");
		return Promise.resolve({ ok: true, json: () => { reading.resolve(); return body.promise; } } as Response);
	});
	const ticks: (() => void)[] = [];
	t.mock.method(globalThis, "setInterval", (tick: () => void) => { ticks.push(tick); });
	return {
		ticks,
		async nextRequest() {
			if (!requests.length) await once(arrivals, "request", { signal: AbortSignal.timeout(1500) });
			const request = requests.shift()!;
			await request.reading;
			return request;
		},
		session() {
			const manager = {};
			const status: (string | undefined)[] = [];
			let model = { provider: "relay", id: "first" };
			let stale = false;
			let staleReads = 0;
			const live = <T>(value: T) => {
				if (stale) {
					staleReads++;
					throw new Error("Pi retired this context");
				}
				return value;
			};
			const ui = { theme: { fg: (_color: string, text: string) => text }, setStatus: (_key: string, text?: string) => status.push(text) };
			const emit = (name: string, event = {}) => handlers.get(name)!(event, {
				get mode() { return live("tui"); }, get hasUI() { return live(true); },
				get sessionManager() { return live(manager); }, get model() { return live(model); }, get ui() { return live(ui); },
			} as unknown as ExtensionContext);
			const shutdown = () => {
				if (stale) return;
				emit("session_shutdown");
				stale = true;
			};
			t.after(shutdown);
			return {
				status, emit, shutdown, get staleReads() { return staleReads; },
				select(id: string, provider = "relay") {
					const previousModel = model;
					model = { provider, id };
					emit("model_select", { model, previousModel });
				},
			};
		},
	};
}

test("a late relay result cannot overwrite the new model's balance on the same provider", async t => {
	const { session, nextRequest } = await setup(t);
	const { status, emit, select } = session();
	emit("session_start");
	const old = await nextRequest();
	select("second");
	const current = await nextRequest();
	assert.equal(old.signal.aborted, true);
	current.reply(23);
	await setImmediate();
	old.reply(98);
	await setImmediate();
	assert.deepEqual(status, ["$23.00"]);
	select("third", "another-provider");
	assert.equal(status.at(-1), undefined);
});

test("a queued timer and a pending response never read the retired relay context", async t => {
	const { session, nextRequest, ticks } = await setup(t);
	const old = session();
	old.emit("session_start");
	const pending = await nextRequest();
	old.shutdown();
	const replacement = session();
	replacement.emit("session_start");
	const current = await nextRequest();
	current.reply(42);
	ticks[0]!();
	assert.equal(pending.signal.aborted, true);
	pending.reply(98);
	await setImmediate();
	assert.equal(old.staleReads, 0);
	assert.deepEqual(old.status, [undefined]);
	assert.deepEqual(replacement.status, ["$42.00"]);
});
