import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import imagegen from "./index.ts";

type Result = {
	content: { type: string; data?: string }[];
	details: { jobId: string; phase: string; file?: string; width?: number };
	usage?: { cost: { total: number } };
	isError?: boolean;
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

type TestTool = {
	name: string;
	execute(id: string, input: object, signal: AbortSignal | undefined, update: undefined, ctx: unknown): Promise<Result>;
};

function setup(t: TestContext) {
	const cwd = mkdtempSync(join(tmpdir(), "imagegen-job-"));
	const prior = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = cwd;
	writeFileSync(
		join(cwd, "imagegen.json"),
		JSON.stringify({
			providers: { test: { baseUrl: "https://image.example/v1", apiKey: "test-key" } },
			models: { flare: { provider: "test", id: "gpt-image-2.6-flare" } },
			defaultModel: "flare",
		}),
	);
	const tools = new Map<string, TestTool>();
	let close = () => {};
	const notice = deferred<{ message: string; level: string }>();
	const notifications: string[] = [];
	const ctx = { cwd, hasUI: true, ui: { notify(message: string, level: string) {
		notifications.push(message);
		notice.resolve({ message, level });
	} } };
	imagegen({
		registerTool: (tool: TestTool) => tools.set(tool.name, tool),
		registerCommand() {},
		on: (event: string, handler: () => void) => { if (event === "session_shutdown") close = handler; },
	} as unknown as ExtensionAPI);
	t.after(() => {
		close();
		if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prior;
		rmSync(cwd, { recursive: true, force: true });
	});
	return {
		launch: (prompt: string, signal?: AbortSignal) => tools.get("generate_image")!.execute("launch", { prompt }, signal, undefined, ctx),
		status: (jobId: string) => tools.get("imagegen_result")!.execute("status", { jobId }, undefined, undefined, ctx),
		close: () => close(), notice, notifications,
	};
}

test("image generation returns before fetch, and a pending result never waits", { timeout: 3_000 }, async (t) => {
	const { launch, status, notice } = setup(t);
	const started = deferred<void>();
	const response = deferred<Response>();
	const mock = t.mock.method(globalThis, "fetch", async () => {
		started.resolve();
		return response.promise;
	});
	const turn = new AbortController();
	const { details: { jobId, phase } } = await launch("a fox", turn.signal);
	assert.equal(phase, "queued");
	assert.equal(mock.mock.callCount(), 0);
	assert.equal((await status(jobId)).details.phase, "queued");
	turn.abort();
	await started.promise;
	assert.equal((await status(jobId)).details.phase, "running");

	const png = Buffer.alloc(24);
	png.write("\x89PNG\r\n\x1a\n", "latin1");
	png.writeUInt32BE(1254, 16);
	png.writeUInt32BE(1254, 20);
	const data = png.toString("base64");
	response.resolve(Response.json({ data: [{ b64_json: data }] }));
	const notification = await notice.promise;
	const finished = await status(jobId);
	assert.equal(notification.level, "info");
	assert.ok(notification.message.includes(finished.details.file!));
	assert.equal(finished.details.phase, "done");
	assert.equal(finished.details.width, 1254);
	assert.deepEqual(finished.content[1], { type: "image", data, mimeType: "image/png" });
	assert.deepEqual(readFileSync(finished.details.file!), png);
	assert.equal(finished.usage?.cost.total, 0.02);
	assert.equal((await status(jobId)).usage, undefined);
});

test("image jobs run serially, report failure, and abort on session shutdown", { timeout: 3_000 }, async (t) => {
	const { launch, status, notice, close, notifications } = setup(t);
	const first = deferred<Response>();
	const nextStarted = deferred<AbortSignal>();
	const aborted = deferred<void>();
	let calls = 0;
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
		calls += 1;
		if (calls === 1) return first.promise;
		const signal = init.signal!;
		return new Promise<Response>((_resolve, reject) => {
			signal.addEventListener("abort", () => { aborted.resolve(); reject(signal.reason); }, { once: true });
			nextStarted.resolve(signal);
		});
	});
	const a = (await launch("first")).details.jobId;
	const b = (await launch("second")).details.jobId;
	const c = (await launch("third")).details.jobId;
	await setImmediate();
	assert.equal(calls, 1);
	assert.equal((await status(b)).details.phase, "queued");
	first.resolve(new Response("bad prompt", { status: 400 }));
	assert.equal((await notice.promise).level, "error");
	assert.equal((await status(a)).isError, true);
	const signal = await nextStarted.promise;
	assert.equal((await status(c)).details.phase, "queued");
	close();
	assert.equal(signal.aborted, true);
	await aborted.promise;
	await setImmediate();
	assert.equal(notifications.length, 1);
	assert.equal(calls, 2);
	await assert.rejects(() => status(b), /Unknown image job/);
});
