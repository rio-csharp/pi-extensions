import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, type AgentScope } from "./agents.ts";
import { type ChildControl, getContextModel, providerEnvNames, runChild, selectedProvider } from "./process.ts";
import type { Semaphore } from "./slots.ts";
import {
	PERSISTED_TASK_OUTPUT_CAP,
	RESULT_DETAILS_DIAGNOSTIC_TOTAL_CAP,
	RESULT_DIAGNOSTIC_CAP,
	STATUS_DETAIL_OUTPUT_CAP,
	STATUS_DETAIL_TOTAL_CAP,
	SUPERVISOR_MESSAGE_CAP,
	boundedMetadata,
	compactDiagnostic,
	effectiveModel,
	getResultOutput,
	isFailedResult,
	sanitizeBounded,
	truncateTaskOutput,
	truncateUtf8,
} from "./text.ts";
import type {
	BackgroundJobStatus,
	SingleResult,
	SubagentDetails,
	SubagentJobTaskState,
	SubagentMode,
} from "./types.ts";

const JOB_DEFINITION_ENTRY_TYPE = "subagent-supervisor-definition";
const JOB_STATE_ENTRY_TYPE = "subagent-supervisor-state";
const SHUTDOWN_WAIT_MS = 7_500;
const MAX_LISTED_JOBS = 50;
const MAX_LISTED_FAILURES = 5;

export interface JobItem {
	agent?: string;
	title: string;
	task: string;
	cwd?: string;
}

interface JobTask extends JobItem {
	sessionId: string;
	attempts: number;
	completed: boolean;
	output?: string;
	result?: SingleResult;
	model?: string;
	control?: ChildControl;
}

export interface BackgroundJob {
	id: string;
	mode: SubagentMode;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	defaultCwd: string;
	confirmProjectAgents: boolean;
	tasks: JobTask[];
	status: BackgroundJobStatus;
	startedAt: number;
	finishedAt?: number;
	controller?: AbortController;
	completion?: Promise<void>;
	runtimeGeneration?: number;
}

interface PersistedJobDefinition {
	id: string;
	mode: SubagentMode;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	defaultCwd: string;
	confirmProjectAgents: boolean;
	tasks: Array<Pick<JobTask, "agent" | "title" | "task" | "cwd" | "sessionId" | "model">>;
	startedAt: number;
}

interface PersistedJobState {
	id: string;
	status?: BackgroundJobStatus;
	finishedAt?: number | null;
	task?: {
		index: number;
		attempts: number;
		completed: boolean;
		output?: string | null;
		model?: string;
	};
}

export class JobStore {
	private jobs = new Map<string, BackgroundJob>();
	private shuttingDown = false;
	private generation = 0;
	private readonly pi: ExtensionAPI;
	private readonly semaphore: Semaphore;
	private readonly whileRunning: <T>(
		agentName: string,
		title: string | undefined,
		ctx: ExtensionContext,
		run: (onStatusUpdate: (result: SingleResult) => void) => Promise<T>,
		model?: string,
	) => Promise<T>;

	constructor(
		pi: ExtensionAPI,
		semaphore: Semaphore,
		whileRunning: JobStore["whileRunning"],
	) {
		this.pi = pi;
		this.semaphore = semaphore;
		this.whileRunning = whileRunning;
	}

	list(): BackgroundJob[] {
		return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
	}

	get(id: string): BackgroundJob | undefined {
		return this.jobs.get(id);
	}

	start(
		init: {
			mode: SubagentMode;
			agentScope: AgentScope;
			projectAgentsDir: string | null;
			confirmProjectAgents: boolean;
			items: JobItem[];
		},
		agents: AgentConfig[],
		ctx: ExtensionContext,
	): BackgroundJob {
		const jobId = `sub-${randomUUID()}`;
		const job: BackgroundJob = {
			id: jobId,
			runtimeGeneration: this.generation,
			mode: init.mode,
			agentScope: init.agentScope,
			projectAgentsDir: init.projectAgentsDir,
			defaultCwd: ctx.cwd,
			confirmProjectAgents: init.confirmProjectAgents,
			tasks: init.items.map((item, index) => ({
				...item,
				sessionId: `${jobId}-${index + 1}`,
				attempts: 0,
				completed: false,
				model: agents.find((agent) => agent.name === item.agent)?.model ?? getContextModel(ctx),
			})),
			status: "interrupted",
			startedAt: Date.now(),
		};
		this.jobs.set(job.id, job);
		this.persistDefinition(job);
		this.persistState(job);
		job.completion = this.run(job, agents, ctx);
		return job;
	}

	resume(job: BackgroundJob, agents: AgentConfig[], ctx: ExtensionContext, continuation?: string): void {
		job.completion = this.run(job, agents, ctx, continuation);
	}

	cancel(job: BackgroundJob): void {
		job.status = "canceling";
		this.persistState(job);
		job.controller?.abort();
	}

	restore(ctx: ExtensionContext): void {
		this.generation++;
		this.shuttingDown = false;
		for (const job of this.jobs.values()) {
			job.runtimeGeneration = -1;
			job.controller?.abort();
		}
		this.jobs.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === JOB_DEFINITION_ENTRY_TYPE) {
				const data = entry.data as PersistedJobDefinition | undefined;
				if (!data?.id) continue;
				this.jobs.set(data.id, {
					id: data.id,
					mode: data.mode,
					agentScope: data.agentScope,
					projectAgentsDir: data.projectAgentsDir,
					defaultCwd: data.defaultCwd,
					confirmProjectAgents: data.confirmProjectAgents,
					tasks: data.tasks.map((task) => ({ ...task, attempts: 0, completed: false })),
					status: "interrupted",
					startedAt: data.startedAt,
				});
				continue;
			}
			if (entry.customType === JOB_STATE_ENTRY_TYPE) {
				const data = entry.data as PersistedJobState | undefined;
				const job = data?.id ? this.jobs.get(data.id) : undefined;
				if (!job || !data) continue;
				if (data.status) job.status = data.status;
				if (data.finishedAt === null) delete job.finishedAt;
				else if (data.finishedAt !== undefined) job.finishedAt = data.finishedAt;
				if (data.task) {
					const task = job.tasks[data.task.index];
					if (task) {
						task.attempts = data.task.attempts;
						task.completed = data.task.completed;
						if (data.task.output === null) delete task.output;
						else if (data.task.output !== undefined) task.output = data.task.output;
						if (data.task.model !== undefined) task.model = data.task.model;
					}
				}
			}
		}
		for (const job of this.jobs.values()) {
			job.runtimeGeneration = this.generation;
			if (job.status === "running" || job.status === "canceling") job.status = "interrupted";
		}
	}

	async shutdown(): Promise<void> {
		const shutdownGeneration = this.generation;
		const completions: Promise<void>[] = [];
		const activeJobs: BackgroundJob[] = [];
		for (const job of this.jobs.values()) {
			if (job.status === "running" || job.status === "canceling") {
				job.status = "interrupted";
				job.finishedAt = Date.now();
				this.persistState(job);
				activeJobs.push(job);
			}
			if (job.completion) completions.push(job.completion);
		}

		this.shuttingDown = true;
		for (const job of activeJobs) job.controller?.abort();
		this.semaphore.rejectAll(new Error("Session is shutting down"));
		if (completions.length > 0) {
			await Promise.race([
				Promise.allSettled(completions),
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
					timer.unref?.();
				}),
			]);
		}
		if (this.generation !== shutdownGeneration) return;
		for (const job of activeJobs) {
			job.status = "interrupted";
			job.finishedAt ??= Date.now();
			this.persistState(job);
			job.runtimeGeneration = -1;
		}
		this.generation++;
	}

	private isCurrentRuntime(job: BackgroundJob, generation = job.runtimeGeneration): boolean {
		return generation === this.generation && !this.shuttingDown;
	}

	private isJobRuntimeCurrent(job: BackgroundJob, generation: number): boolean {
		return job.runtimeGeneration === generation && generation === this.generation;
	}

	private persistDefinition(job: BackgroundJob): void {
		if (job.runtimeGeneration !== this.generation || this.shuttingDown) return;
		const persisted: PersistedJobDefinition = {
			id: job.id,
			mode: job.mode,
			agentScope: job.agentScope,
			projectAgentsDir: job.projectAgentsDir,
			defaultCwd: job.defaultCwd,
			confirmProjectAgents: job.confirmProjectAgents,
			tasks: job.tasks.map(({ agent, title, task, cwd, sessionId, model }) => ({ agent, title, task, cwd, sessionId, model })),
			startedAt: job.startedAt,
		};
		this.pi.appendEntry(JOB_DEFINITION_ENTRY_TYPE, persisted);
	}

	private persistState(job: BackgroundJob, taskIndex?: number): void {
		if (job.runtimeGeneration !== undefined && job.runtimeGeneration !== this.generation) return;
		const task = taskIndex === undefined ? undefined : job.tasks[taskIndex];
		const persisted: PersistedJobState = {
			id: job.id,
			status: job.status,
			finishedAt: job.finishedAt ?? null,
			task: task && taskIndex !== undefined
				? {
					index: taskIndex,
					attempts: task.attempts,
					completed: task.completed,
					output: task.output ?? null,
					model: task.model,
				}
				: undefined,
		};
		this.pi.appendEntry(JOB_STATE_ENTRY_TYPE, persisted);
	}

	private taskState(job: BackgroundJob, task: JobTask): SubagentJobTaskState {
		if (task.completed) return "succeeded";
		if (task.result && isFailedResult(task.result)) return "failed";
		if (job.status === "running" && task.attempts > 0) return "running";
		if (task.attempts > 0 && task.output && job.status !== "canceled") return "failed";
		return "pending";
	}

	private jobResults(job: BackgroundJob): SingleResult[] {
		const results: SingleResult[] = [];
		let diagnosticBytes = 0;
		for (const task of job.tasks) {
			const result = task.result;
			if (!result) continue;
			const hasErrorMessage = Boolean(result.errorMessage);
			const remainingDiagnosticBytes = Math.max(0, RESULT_DETAILS_DIAGNOSTIC_TOTAL_CAP - diagnosticBytes);
			const diagnostic = sanitizeBounded(
				result.errorMessage ?? result.stderr,
				Math.min(RESULT_DIAGNOSTIC_CAP, remainingDiagnosticBytes),
				"Diagnostic output truncated",
			);
			diagnosticBytes += Buffer.byteLength(diagnostic, "utf8");
			results.push({
				...result,
				task: "[omitted from background details]",
				messages: [],
				stderr: hasErrorMessage ? "" : diagnostic,
				errorMessage: hasErrorMessage ? diagnostic : undefined,
				agent: boundedMetadata(result.agent),
				provider: result.provider ? boundedMetadata(result.provider) : undefined,
				model: result.model ? boundedMetadata(result.model) : undefined,
			});
		}
		return results;
	}

	details(job: BackgroundJob): SubagentDetails {
		return {
			mode: job.mode,
			agentScope: job.agentScope,
			projectAgentsDir: job.projectAgentsDir ? boundedMetadata(job.projectAgentsDir, 2 * 1024) : null,
			results: this.jobResults(job),
			background: true,
			jobId: job.id,
			jobStatus: job.status,
			startedAt: job.startedAt,
			finishedAt: job.finishedAt,
			tasks: job.tasks.map((task) => ({
				agent: boundedMetadata(task.agent ?? "default"),
				title: boundedMetadata(task.title),
				sessionId: boundedMetadata(task.sessionId),
				attempts: task.attempts,
				completed: task.completed,
				model: task.model ? boundedMetadata(task.model) : undefined,
				state: this.taskState(job, task),
			})),
		};
	}

	summarize(job: BackgroundJob, includeOutput = false): string {
		const counts = { succeeded: 0, failed: 0, pending: 0, running: 0 };
		for (const task of job.tasks) counts[this.taskState(job, task)]++;
		const elapsed = Math.max(0, (job.finishedAt ?? Date.now()) - job.startedAt);
		const lines = [
			`jobId: ${boundedMetadata(job.id)}`,
			`status: ${boundedMetadata(String(job.status))}`,
			`mode: ${boundedMetadata(String(job.mode))}`,
			`tasks: ${job.tasks.length} total · ${counts.succeeded} succeeded · ${counts.failed} failed · ${counts.running} running · ${counts.pending} pending`,
			`elapsedMs: ${elapsed}`,
			`started: ${new Date(job.startedAt).toISOString()}`,
		];
		if (job.finishedAt) lines.push(`finished: ${new Date(job.finishedAt).toISOString()}`);

		const failures = job.tasks.filter((task) => this.taskState(job, task) === "failed");
		for (const [index, task] of failures.slice(0, MAX_LISTED_FAILURES).entries()) {
			const diagnostic = compactDiagnostic(task.output ?? task.result?.errorMessage ?? task.result?.stderr);
			lines.push(`failure ${index + 1}: ${boundedMetadata(task.title)} (${boundedMetadata(task.agent ?? "default")})${diagnostic ? ` · ${diagnostic}` : ""}`);
		}
		if (failures.length > MAX_LISTED_FAILURES) lines.push(`failures: +${failures.length - MAX_LISTED_FAILURES} more`);

		if (includeOutput) {
			lines.push("", `Task output (opt-in; redacted; max ${STATUS_DETAIL_OUTPUT_CAP / 1024} KB per task, ${STATUS_DETAIL_TOTAL_CAP / 1024} KB total):`);
			for (const [index, task] of job.tasks.entries()) {
				if (!task.output) continue;
				lines.push(`\n### task ${index + 1}: ${boundedMetadata(task.title)} (${boundedMetadata(task.agent ?? "default")}) · ${this.taskState(job, task)}`);
				lines.push(sanitizeBounded(task.output, STATUS_DETAIL_OUTPUT_CAP, "Task output truncated"));
			}
			return truncateUtf8(lines.join("\n"), STATUS_DETAIL_TOTAL_CAP, "Detailed status truncated");
		}
		return lines.join("\n");
	}

	summarizeList(): string {
		const listed = this.list().slice(0, MAX_LISTED_JOBS);
		if (listed.length === 0) return "No supervised subagent jobs in this session.";
		const omitted = this.jobs.size - listed.length;
		return `${listed.map((job) => this.summarize(job)).join("\n\n---\n\n")}${omitted > 0 ? `\n\n${omitted} older job(s) omitted.` : ""}`;
	}

	async steer(job: BackgroundJob, taskIndex: number | undefined, instruction: string): Promise<{ ok: boolean; text: string }> {
		if (job.status !== "running") {
			return { ok: false, text: `Cannot steer ${job.id}; job status is ${job.status}.` };
		}

		let index = taskIndex;
		if (index === undefined) {
			const runningIndexes = job.tasks
				.map((task, i) => (task.control ? i : -1))
				.filter((i) => i >= 0);
			if (runningIndexes.length !== 1) {
				return {
					ok: false,
					text: runningIndexes.length === 0
						? `No child in ${job.id} is currently accepting steering messages.`
						: `${job.id} has ${runningIndexes.length} running children; provide taskIndex (${runningIndexes.join(", ")}).`,
				};
			}
			index = runningIndexes[0];
		}

		const task = job.tasks[index];
		if (!task) {
			return { ok: false, text: `Invalid taskIndex ${index}; ${job.id} has ${job.tasks.length} task(s), indexed 0-${Math.max(0, job.tasks.length - 1)}.` };
		}
		if (!task.control) {
			return { ok: false, text: `Task ${index} (${boundedMetadata(task.title)}) is not currently accepting steering messages.` };
		}

		try {
			await task.control.steer(instruction);
			return { ok: true, text: `Steering instruction queued for task ${index} (${boundedMetadata(task.title)}) in ${job.id}.` };
		} catch (error) {
			return { ok: false, text: `Failed to steer task ${index} in ${job.id}: ${compactDiagnostic(error instanceof Error ? error.message : String(error)) ?? "unknown RPC error"}` };
		}
	}

	private notify(job: BackgroundJob): void {
		if (this.shuttingDown) return;
		const action = job.status === "completed" ? "Use the results below." : "The job can be resumed with subagent_jobs action=resume.";
		const content = sanitizeBounded(
			[
				`[Subagent supervisor event] Background job ${boundedMetadata(job.id)} is ${boundedMetadata(String(job.status))}.`,
				action,
				"This notification is one-way: do not wait for the child process, and do not assume the child is waiting for you.",
				"",
				this.summarize(job),
				"",
				"Completed task outputs (bounded for the parent model):",
				...job.tasks.map((task, index) =>
					`\n### task ${index + 1}: ${boundedMetadata(task.title)} (${boundedMetadata(task.agent ?? "default")}) · ${this.taskState(job, task)}\n${truncateTaskOutput(task.output ?? "(no output)")}`,
				),
			].join("\n"),
			SUPERVISOR_MESSAGE_CAP,
			"Supervisor message truncated; use subagent_jobs status for task summaries",
		);
		this.pi.sendMessage(
			{
				customType: "subagent-supervisor",
				content,
				display: true,
				details: this.details(job),
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	}

	private async run(job: BackgroundJob, agents: AgentConfig[], ctx: ExtensionContext, continuation?: string): Promise<void> {
		if (job.status === "running") return;
		const runGeneration = this.generation;
		job.status = "running";
		job.finishedAt = undefined;
		job.runtimeGeneration = runGeneration;
		const controller = new AbortController();
		job.controller = controller;
		this.persistState(job);

		try {
			const executeTask = async (task: JobTask, index: number, prompt: string): Promise<SingleResult> => {
				const isPersistedResume = task.attempts > 0;
				task.attempts++;
				task.completed = false;
				task.output = undefined;
				task.result = undefined;
				task.control = undefined;
				const agent = task.agent ? agents.find((a) => a.name === task.agent) : undefined;
				if (!isPersistedResume) {
					task.model ??= agent?.model ?? getContextModel(ctx);
				}
				if (!this.isJobRuntimeCurrent(job, runGeneration)) throw new Error("Subagent runtime was retired");
				this.persistState(job, index);
				const selectedModel = isPersistedResume && !task.model ? null : task.model;
				const provider = selectedModel?.includes("/")
					? selectedModel.split("/", 1)[0]
					: selectedProvider(agents, task.agent, ctx);
				const result = await this.semaphore.with(controller.signal, () =>
					this.whileRunning(
						task.agent ?? "default",
						task.title,
						ctx,
						(onStatusUpdate) =>
							runChild({
								defaultCwd: job.defaultCwd,
								agent,
								agentName: task.agent ?? "default",
								task: prompt,
								cwd: task.cwd,
								step: job.mode === "chain" ? index + 1 : undefined,
								signal: controller.signal,
								sessionId: task.sessionId,
								inheritedModel: selectedModel,
								provider,
								providerEnvNames: providerEnvNames(provider, ctx),
								makeDetails: (results) => ({ ...this.details(job), results }),
								onStatusUpdate: (updated) => {
									if (!this.isJobRuntimeCurrent(job, runGeneration)) return;
									const observedModel = effectiveModel(updated.provider, updated.model);
									if (observedModel && observedModel !== task.model) {
										task.model = observedModel;
										this.persistState(job, index);
									}
									onStatusUpdate(updated);
								},
								onControlChange: (control) => {
									if (!this.isJobRuntimeCurrent(job, runGeneration)) return;
									task.control = control;
								},
							}),
						task.model,
					),
				);
				if (!this.isJobRuntimeCurrent(job, runGeneration)) return result;
				task.result = result;
				task.output = sanitizeBounded(getResultOutput(result), PERSISTED_TASK_OUTPUT_CAP, "Persisted task output truncated");
				task.model = effectiveModel(result.provider, result.model) ?? task.model;
				task.completed = !isFailedResult(result);
				this.persistState(job, index);
				return result;
			};

			if (job.mode === "chain") {
				let previousOutput = "";
				for (const [index, task] of job.tasks.entries()) {
					if (task.completed) {
						previousOutput = task.output ?? previousOutput;
						continue;
					}
					const original = task.task.replace(/\{previous\}/g, previousOutput);
					const prompt = task.attempts > 0
						? `${continuation?.trim() || "Continue the previous task from its persisted session."}\n\nOriginal task:\n${original}`
						: original;
					const result = await executeTask(task, index, prompt);
					if (isFailedResult(result)) break;
					previousOutput = getResultOutput(result);
				}
			} else {
				const pending = job.tasks.map((task, index) => ({ task, index })).filter(({ task }) => !task.completed);
				// allSettled: a rejected (e.g. queue-canceled) task must not finalize the job while siblings are still running.
				await Promise.allSettled(pending.map(({ task, index }) => {
					const prompt = task.attempts > 0
						? `${continuation?.trim() || "Continue the previous task from its persisted session."}\n\nOriginal task:\n${task.task}`
						: task.task;
					return executeTask(task, index, prompt);
				}));
			}

			if (!this.isJobRuntimeCurrent(job, runGeneration)) return;
			if (controller.signal.aborted && this.shuttingDown) job.status = "interrupted";
			else if (controller.signal.aborted) job.status = "canceled";
			else if (job.tasks.every((task) => task.completed)) job.status = "completed";
			else job.status = "interrupted";
		} catch (error) {
			if (!this.isJobRuntimeCurrent(job, runGeneration)) return;
			job.status = this.shuttingDown ? "interrupted" : controller.signal.aborted ? "canceled" : "interrupted";
			const pending = job.tasks.find((task) => !task.completed);
			if (pending) {
				pending.output = sanitizeBounded(
					error instanceof Error ? error.message : String(error),
					RESULT_DIAGNOSTIC_CAP,
					"Error truncated",
				);
			}
		} finally {
			if (!this.isJobRuntimeCurrent(job, runGeneration)) return;
			job.finishedAt ??= Date.now();
			this.persistState(job);
			if (this.isCurrentRuntime(job, runGeneration)) {
				ctx.ui.notify(`Subagent job ${boundedMetadata(job.id)} ${boundedMetadata(String(job.status))}`, job.status === "completed" ? "info" : "warning");
				this.notify(job);
			}
		}
	}
}
