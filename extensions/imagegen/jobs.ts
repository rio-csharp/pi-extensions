import { randomUUID } from "node:crypto";

export type JobState<T> =
	| { phase: "queued" | "running" }
	| { phase: "done"; result: T; usageReported: boolean }
	| { phase: "failed"; error: string };

type Completed<T> = Extract<JobState<T>, { phase: "done" | "failed" }>;
type Work<T> = {
	id: string;
	run: (signal: AbortSignal) => Promise<T>;
	notify: (id: string, state: Completed<T>) => void;
};

const MAX_PENDING = 8;
const MAX_COMPLETED = 8;

export class ImageJobs<T> {
	private readonly states = new Map<string, JobState<T>>();
	private readonly queue: Work<T>[] = [];
	private readonly completed: string[] = [];
	private readonly controller = new AbortController();
	private scheduled?: ReturnType<typeof setImmediate>;
	private running = false;

	enqueue(run: Work<T>["run"], notify: Work<T>["notify"]): string {
		if (this.controller.signal.aborted) throw new Error("Image generation queue is closed.");
		if (this.queue.length + Number(this.running) >= MAX_PENDING) {
			throw new Error("Image generation queue is full. Try again after a job finishes.");
		}
		const id = randomUUID();
		this.states.set(id, { phase: "queued" });
		this.queue.push({ id, run, notify });
		this.schedule();
		return id;
	}

	get(id: string): JobState<T> | undefined {
		return this.states.get(id);
	}

	close(): void {
		if (this.scheduled) clearImmediate(this.scheduled);
		this.scheduled = undefined;
		this.queue.length = 0;
		this.completed.length = 0;
		this.states.clear();
		this.controller.abort();
	}

	private schedule(): void {
		if (this.scheduled || this.running || this.queue.length === 0 || this.controller.signal.aborted) return;
		this.scheduled = setImmediate(() => {
			this.scheduled = undefined;
			void this.runNext();
		});
	}

	private async runNext(): Promise<void> {
		const job = this.queue.shift();
		if (!job) return;
		this.running = true;
		this.states.set(job.id, { phase: "running" });
		const signal = this.controller.signal;
		try {
			let state: Completed<T>;
			try {
				state = { phase: "done", result: await job.run(signal), usageReported: false };
			} catch (error) {
				state = { phase: "failed", error: error instanceof Error ? error.message : String(error) };
			}
			if (signal.aborted) return;
			this.states.set(job.id, state);
			this.completed.push(job.id);
			if (this.completed.length > MAX_COMPLETED) this.states.delete(this.completed.shift()!);
			try {
				job.notify(job.id, state);
			} catch {
				// UI delivery is best effort; the result is still available to query.
			}
		} finally {
			this.running = false;
			this.schedule();
		}
	}
}
