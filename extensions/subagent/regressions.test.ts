import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import activate from "./index.ts";
import { JobStore } from "./jobs.ts";
import { runChild } from "./process.ts";
import { Semaphore } from "./slots.ts";
import { getResultOutput, isFailedResult } from "./text.ts";

const fixture = fileURLToPath(new URL("./test-fixtures/rpc-child.mjs", import.meta.url));
const cwd = dirname(dirname(fixture));
const originalArgv = [...process.argv];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let testAgentDir: string;
before(() => {
	testAgentDir = mkdtempSync(join(tmpdir(), "subagent-regressions-"));
	process.env.PI_CODING_AGENT_DIR = testAgentDir;
	process.argv[1] = fixture;
});
after(() => {
	process.argv.splice(0, process.argv.length, ...originalArgv);
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(testAgentDir, { recursive: true, force: true });
});

function harness() {
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
	const handlers = new Map<string, (event: BeforeAgentStartEvent, ctx: ExtensionToolContext) => unknown>();
	const pi = {
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
		getActiveTools: () => [],
		getAllTools: () => [],
		on(name: string, handler: (event: BeforeAgentStartEvent, ctx: ExtensionToolContext) => unknown) { handlers.set(name, handler); },
		registerMessageRenderer() {},
		registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.set(tool.name, tool),
		sendMessage() {},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		modelRegistry: { find: () => undefined, getAll: () => [] },
		sessionManager: { getBranch: () => entries },
		ui: { notify() {} },
	} as unknown as ExtensionToolContext;
	return { pi, ctx, tools, entries, handlers };
}

for (const mode of ["chain", "parallel"] as const) {
	test(`canceling a queued ${mode} task preserves zero attempts across restore and resume`, async () => {
		const { pi, ctx, entries } = harness();
		const semaphore = new Semaphore(() => 1);
		const release = await semaphore.acquire(new AbortController().signal);
		const createStore = () => new JobStore(pi, semaphore, (_title, _ctx, run) => run(() => {}));
		const store = createStore();
		const job = store.start({ mode, items: [{ title: "Fresh task", task: "original prompt" }] }, ctx);
		assert.deepEqual(store.details(job).tasks?.map(({ state, attempts }) => [state, attempts]), [["pending", 0]]);
		assert.match(store.summarize(job), /0 running · 1 pending/);
		store.cancel(job);
		await job.completion;
		assert.equal(job.status, "canceled");
		assert.equal(job.tasks[0].output, undefined);
		assert.ok(entries.every(({ data }) => !(data as { task?: unknown }).task));
		release();

		const restored = createStore();
		restored.restore(ctx);
		const retry = restored.get(job.id)!;
		restored.resume(retry, ctx, "continue if started");
		await retry.completion;
		assert.equal(retry.status, "completed");
		assert.equal(retry.tasks[0].sessionId, job.tasks[0].sessionId);
		assert.equal(retry.tasks[0].attempts, 1);
		assert.equal(retry.tasks[0].output, "original prompt");
	});
}

test("parallel status distinguishes a running retry from a queued retry", async () => {
	const { pi, ctx } = harness();
	const semaphore = new Semaphore(() => 1);
	const store = new JobStore(pi, semaphore, (_title, _ctx, run) => run(() => {}));
	const job = store.start({ mode: "parallel", items: ["fail startup", "exit early"].map((task) => ({ title: task, task })) }, ctx);
	await job.completion;
	assert.equal(job.status, "interrupted");
	store.resume(job, ctx, "retry instruction");
	await Promise.resolve();
	assert.deepEqual(store.details(job).tasks?.map(({ state, attempts }) => [state, attempts]), [["running", 2], ["pending", 1]]);
	store.cancel(job);
	await job.completion;
	assert.match(job.tasks[0].result!.task, /^retry instruction\n\nOriginal task:\nfail startup$/);
	assert.equal(job.tasks[1].attempts, 1);
	assert.match(job.tasks[1].output!, /closed before the task settled/);
});

const chain = [{ title: "First step", task: "produce previous" }, { title: "Second step", task: "before {previous} and {previous} after" }];
const expected = "before $& $$ $` $' {previous} and $& $$ $` $' {previous} after";

test("both chain modes substitute previous output literally", async () => {
	const { pi, ctx, tools } = harness();
	activate(pi);
	const foreground = await tools.get("subagent")!.execute("fg", { chain, background: false }, undefined, undefined, ctx);
	assert.deepEqual(foreground.content, [{ type: "text", text: expected }]);

	const store = new JobStore(pi, new Semaphore(() => 1), (_title, _ctx, run) => run(() => {}));
	const background = store.start({ mode: "chain", items: chain }, ctx);
	await background.completion;
	assert.equal(background.status, "completed");
	assert.equal(background.tasks[1].output, expected);
});

test("invalid dispatch mode returns a tool error and unknown model fails before background persistence", async () => {
	const { pi, ctx, tools, entries } = harness();
	activate(pi);
	const dispatch = tools.get("subagent")!;
	const invalid = await dispatch.execute("invalid", { title: "", chain }, undefined, undefined, ctx);
	assert.equal(invalid.isError, true);
	const invalidChain = [chain[0], { ...chain[1], model: "missing/model" }];
	let updates = 0;
	for (const background of [true, false]) {
		await assert.rejects(
			dispatch.execute("missing", { chain: invalidChain, background }, undefined, () => { updates++; }, ctx),
			/Model override.*not found/,
		);
	}
	assert.equal(updates, 0);
	assert.deepEqual(entries, []);
});

test("configured default drives model selection and is published with authenticated overrides", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-default-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	});
	const config = join(dir, "subagent.json");
	writeFileSync(config, JSON.stringify({ defaultModel: "worker:low" }));
	const { pi, ctx, tools, handlers } = harness();
	const models = ["parent", "worker", "other", "unauthenticated"].map((id) => ({ provider: "relay", id }));
	const runtimeCtx = {
		...ctx,
		model: models[0],
		modelRegistry: {
			find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
			getAll: () => models,
			getAvailable: () => models.slice(0, 3),
			hasConfiguredAuth: (model: { id: string }) => model.id !== "unauthenticated",
			getRegisteredProviderConfig: () => undefined,
		},
	} as unknown as ExtensionToolContext;
	activate(pi);
	const event = { systemPromptOptions: { sections: {} as Record<string, string>, selectedTools: ["subagent"] } };
	const addGuidance = handlers.get("before_agent_start")!;
	addGuidance(event as BeforeAgentStartEvent, runtimeCtx);
	const guidance = event.systemPromptOptions.sections.subagent_models;
	assert.match(guidance, /relay\/worker:low.*omitting model/);
	assert.match(guidance, /Available models:.*relay\/other.*relay\/parent.*relay\/worker/);
	assert.doesNotMatch(guidance, /unauthenticated/);
	event.systemPromptOptions.selectedTools = [];
	addGuidance(event as BeforeAgentStartEvent, runtimeCtx);
	assert.equal(event.systemPromptOptions.sections.subagent_models, undefined);

	const dispatch = tools.get("subagent")!;
	const args = { title: "Check model", task: "show model", background: false };
	const run = (overrides: unknown = {}) => dispatch.execute("default", { ...args, ...(overrides as Record<string, unknown>) }, undefined, undefined, runtimeCtx);
	const modelOf = (result: Awaited<ReturnType<typeof run>>) => (result.details as { results: { model: string }[] }).results[0].model;
	assert.equal(modelOf(await run()), "relay/worker");
	const prepared = dispatch.prepareArguments!({ ...args, model: " ", thinking: "", cwd: "", tools: "" });
	assert.equal(modelOf(await run(prepared)), "relay/worker");
	await assert.rejects(run(dispatch.prepareArguments!({ ...args, model: "missing/model" })), /Model override.*not found/);
	assert.equal(modelOf(await run({ model: "relay/other" })), "relay/other");
	writeFileSync(config, JSON.stringify({ defaultModel: "relay/unauthenticated" }));
	await assert.rejects(run(), /defaultModel.*unavailable/);
	assert.equal(modelOf(await run({ model: "relay/other" })), "relay/other");
	writeFileSync(config, "{}");
	assert.equal(modelOf(await run()), "relay/parent");
});

test("supervisor drops unrelated fields without changing the action's meaningful fields", async () => {
	const { pi, ctx, tools } = harness();
	activate(pi);
	const supervisor = tools.get("subagent_jobs")!;
	const list = supervisor.prepareArguments!({ action: "list", model: "", tools: 42, thinking: "unused", taskIndex: -1 });
	assert.deepEqual(list, { action: "list" });
	assert.equal((await supervisor.execute("list", list, undefined, undefined, ctx)).isError, undefined);
	const steer = supervisor.prepareArguments!({ action: "steer", jobId: " job ", instruction: "do this", model: "", thinking: "medium", tools: [], taskIndex: 0 });
	assert.deepEqual(steer, { action: "steer", jobId: "job", instruction: "do this", taskIndex: 0 });
	assert.deepEqual(supervisor.prepareArguments!({ action: "resume", jobId: "job", model: " ", thinking: " HIGH ", tools: [] }), {
		action: "resume", jobId: "job", thinking: "high", tools: [],
	});
	assert.deepEqual(supervisor.prepareArguments!({ action: "steer", jobId: "job", instruction: " " }), { action: "steer", jobId: "job" });
});

test("child launch resolves a relative cwd against the session and diagnoses bad directories", async () => {
	const run = (override: string) => runChild({ defaultCwd: cwd, cwd: override, task: "show cwd", makeDetails: (results) => ({ mode: "single", results }) });
	assert.equal(realpathSync(getResultOutput(await run("test-fixtures"))), realpathSync(dirname(fixture)));
	for (const override of ["missing-directory", "test-fixtures/rpc-child.mjs"]) {
		const result = await run(override);
		assert.ok(isFailedResult(result));
		assert.match(getResultOutput(result), /Invalid subagent working directory/);
	}
});

test("RPC launch reports startup stderr and distinguishes early exit from handled prompts", { timeout: 5_000 }, async () => {
	const run = (task: string) => runChild({ defaultCwd: cwd, task, makeDetails: (results) => ({ mode: "single", results }) });
	const failed = await run("fail startup");
	assert.ok(isFailedResult(failed));
	assert.equal(getResultOutput(failed), "Requested model unavailable in child");
	const premature = await run("exit early");
	assert.ok(isFailedResult(premature));
	assert.match(getResultOutput(premature), /closed before the task settled/);
	assert.equal(isFailedResult(await run("handled")), false);
});
