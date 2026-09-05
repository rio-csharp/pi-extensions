type Release = () => void;

interface Waiter {
	resolve: (release: Release) => void;
	reject: (error: Error) => void;
	signal: AbortSignal;
	onAbort: () => void;
}

const QUEUE_CANCEL_MESSAGE = "Subagent job was canceled while queued";

export class Semaphore {
	private active = 0;
	private waiters: Waiter[] = [];
	private readonly limit: () => number;

	constructor(limit: () => number) {
		this.limit = limit;
	}

	acquire(signal: AbortSignal): Promise<Release> {
		if (signal.aborted) return Promise.reject(new Error(QUEUE_CANCEL_MESSAGE));
		if (this.active < this.limit()) {
			this.active++;
			return Promise.resolve(() => this.release());
		}
		return new Promise((resolve, reject) => {
			const waiter: Waiter = {
				resolve,
				reject,
				signal,
				onAbort: () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(new Error(QUEUE_CANCEL_MESSAGE));
				},
			};
			this.waiters.push(waiter);
			signal.addEventListener("abort", waiter.onAbort, { once: true });
		});
	}

	async with<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
		const release = await this.acquire(signal);
		try {
			return await run();
		} finally {
			release();
		}
	}

	rejectAll(error: Error): void {
		for (const waiter of this.waiters.splice(0)) {
			waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.reject(error);
		}
	}

	// The limit is re-read at every grant so a live config change takes effect immediately.
	private release(): void {
		this.active = Math.max(0, this.active - 1);
		while (this.waiters.length > 0 && this.active < this.limit()) {
			const waiter = this.waiters[0];
			this.waiters.shift();
			waiter.signal.removeEventListener("abort", waiter.onAbort);
			if (waiter.signal.aborted) continue;
			this.active++;
			waiter.resolve(() => this.release());
		}
	}
}
