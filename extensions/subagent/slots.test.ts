import assert from "node:assert/strict";
import test from "node:test";
import { Semaphore } from "./slots.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

test("semaphore admits up to the limit, then queues in FIFO order", async () => {
	const semaphore = new Semaphore(() => 2);
	const never = new AbortController().signal;

	const gate1 = deferred<string>();
	const gate2 = deferred<string>();
	const order: string[] = [];

	const releases = [
		await semaphore.acquire(never),
		await semaphore.acquire(never),
	];
	const queued = [
		semaphore.acquire(never).then(async (release) => { await gate1.promise; order.push("third"); release(); }),
		semaphore.acquire(never).then(async (release) => { await gate2.promise; order.push("fourth"); release(); }),
	];

	releases[0]();
	await new Promise((r) => setImmediate(r));
	releases[1]();
	gate1.resolve("go");
	gate2.resolve("go");
	await Promise.all(queued);
	assert.deepEqual(order, ["third", "fourth"]);
});

test("semaphore rejects waiters whose signal aborts while queued", async () => {
	const semaphore = new Semaphore(() => 1);
	const never = new AbortController().signal;
	const release = await semaphore.acquire(never);

	const controller = new AbortController();
	const waiting = semaphore.acquire(controller.signal);
	controller.abort();
	await assert.rejects(waiting, /canceled while queued/);
	release();
});

test("semaphore honors a lowered limit until enough slots are released", async () => {
	let limit = 3;
	const semaphore = new Semaphore(() => limit);
	const never = new AbortController().signal;
	const releases = [await semaphore.acquire(never), await semaphore.acquire(never), await semaphore.acquire(never)];

	limit = 1;
	let granted = false;
	const waiting = semaphore.acquire(never).then((release) => { granted = true; return release; });

	releases[0]();
	await new Promise((r) => setImmediate(r));
	assert.equal(granted, false);

	releases[1]();
	releases[2]();
	const release = await waiting;
	assert.equal(granted, true);
	release();
});

test("semaphore rejectAll fails every queued waiter", async () => {
	const semaphore = new Semaphore(() => 1);
	const never = new AbortController().signal;
	const release = await semaphore.acquire(never);
	const waiting = [semaphore.acquire(never), semaphore.acquire(never)];
	semaphore.rejectAll(new Error("Session is shutting down"));
	await Promise.all(waiting.map((promise) => assert.rejects(promise, /shutting down/)));
	release();
});
