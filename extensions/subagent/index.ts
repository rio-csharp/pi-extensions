/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { SubagentJobsParams, SubagentParams } from "./schema.ts";
import { buildChildEnvironment, quoteExactPath, referencedEnvironmentNames, terminalSanitize } from "./security.ts";
import { createSubagentStatusPublisher } from "./status-publisher.ts";
import {
	renderSubagentSupervisorMessage,
	subagentJobsRenderer,
	subagentTimelineRenderer,
} from "./timeline-renderer.ts";
import type {
	BackgroundJobStatus,
	SingleResult,
	SubagentDetails,
	SubagentJobTaskState,
	SubagentMode,
} from "./types.ts";

const MAX_PARALLEL_TASKS = 100;
const MAX_CONCURRENCY = 20;
// The root pi process is depth 0. A subagent at depth 3 is a leaf and
// cannot create more subagents, allowing three nested child levels.
const MAX_SUBAGENT_DEPTH = 3;
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const SUPERVISOR_MESSAGE_CAP = 50 * 1024;
const STATUS_DETAIL_OUTPUT_CAP = 4 * 1024;
const STATUS_DETAIL_TOTAL_CAP = 20 * 1024;
const PERSISTED_TASK_OUTPUT_CAP = 50 * 1024;
const RESULT_DIAGNOSTIC_CAP = 4 * 1024;
const RESULT_DETAILS_DIAGNOSTIC_TOTAL_CAP = 20 * 1024;
const RESULT_METADATA_FIELD_CAP = 512;
const SHUTDOWN_WAIT_MS = 7_500;

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		return msg.content
			.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateUtf8(output: string, cap: number, suffixLabel: string): string {
	if (cap <= 0) return "";
	const bytes = Buffer.from(output, "utf8");
	if (bytes.byteLength <= cap) return output;

	const suffix = `\n\n[${suffixLabel}.]`;
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	if (suffixBytes >= cap) return Buffer.from(suffix, "utf8").subarray(0, cap).toString("utf8").replace(/\uFFFD$/, "");

	let prefix = bytes.subarray(0, cap - suffixBytes).toString("utf8").replace(/\uFFFD$/, "");
	while (Buffer.byteLength(prefix, "utf8") + suffixBytes > cap) prefix = prefix.slice(0, -1);
	return `${prefix}${suffix}`;
}

/** Best-effort removal of common credentials before text leaves runtime-only child state. */
function redactSensitiveText(value: string): string {
	return value
		.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "<private key redacted>")
		.replace(/(\b(?:proxy-)?authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi, "$1<redacted>")
		.replace(
			/((?:["']?)(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|passwd|credential|cookie|signature)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
			"$1<redacted>",
		)
		.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, "<redacted>")
		.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<jwt redacted>")
		.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, "$1<credentials redacted>@");
}

function sanitizeBounded(value: string, cap: number, suffixLabel: string): string {
	return truncateUtf8(terminalSanitize(redactSensitiveText(value)), cap, suffixLabel);
}

function truncateParallelOutput(output: string): string {
	return sanitizeBounded(output, PER_TASK_OUTPUT_CAP, "Output truncated");
}

function appendBounded(current: string, addition: string, cap: number, suffixLabel = "Diagnostic output truncated"): string {
	if (Buffer.byteLength(current, "utf8") >= cap) return current;
	return truncateUtf8(current + addition, cap, suffixLabel);
}

function compactDiagnostic(value: string | undefined, maxChars = 240): string | undefined {
	const compact = value ? terminalSanitize(redactSensitiveText(value)).replace(/\s+/g, " ").trim() : undefined;
	if (!compact) return undefined;
	return compact.length > maxChars ? `${compact.slice(0, maxChars - 3)}...` : compact;
}

function effectiveModel(provider: string | undefined, model: string | undefined): string | undefined {
	if (!model) return undefined;
	if (!provider || model.startsWith(`${provider}/`)) return model;
	return `${provider}/${model}`;
}

function boundedMetadata(value: string, cap = RESULT_METADATA_FIELD_CAP): string {
	return sanitizeBounded(value, cap, "Metadata truncated").replace(/ +/g, " ").trim();
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	const settled = await Promise.allSettled(workers);
	const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
	if (rejected) throw rejected.reason;
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface BackgroundTask {
	agent: string;
	title: string;
	task: string;
	cwd?: string;
	sessionId: string;
	attempts: number;
	completed: boolean;
	output?: string;
	result?: SingleResult;
	model?: string;
}

interface BackgroundJob {
	id: string;
	mode: SubagentMode;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	defaultCwd: string;
	confirmProjectAgents: boolean;
	tasks: BackgroundTask[];
	status: BackgroundJobStatus;
	startedAt: number;
	finishedAt?: number;
	controller?: AbortController;
	completion?: Promise<void>;
	runtimeGeneration?: number;
}

interface PersistedBackgroundJob {
	id: string;
	mode: SubagentMode;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	defaultCwd: string;
	confirmProjectAgents?: boolean;
	tasks: Array<Omit<BackgroundTask, "result">>;
	status: BackgroundJobStatus;
	startedAt: number;
	finishedAt?: number;
}

interface PersistedJobDefinition {
	id: string;
	mode: SubagentMode;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	defaultCwd: string;
	confirmProjectAgents: boolean;
	tasks: Array<Pick<BackgroundTask, "agent" | "title" | "task" | "cwd" | "sessionId" | "model">>;
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

const LEGACY_JOB_ENTRY_TYPE = "subagent-supervisor-job";
const JOB_DEFINITION_ENTRY_TYPE = "subagent-supervisor-definition";
const JOB_STATE_ENTRY_TYPE = "subagent-supervisor-state";

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	sessionId: string | undefined,
	inheritedModel: string | null | undefined,
	provider: string | undefined,
	providerEnvironmentNames: readonly string[],
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	onStatusUpdate?: (result: SingleResult) => void,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p"];
	if (sessionId) args.push("--session-id", sessionId);
	else args.push("--no-session");
	// Callers pass the already resolved effective model. This also preserves the
	// model selected when a persisted child session is resumed.
	// `null` means a legacy persisted child whose original effective model was
	// not recorded. Omit --model so Pi can restore it from the child session.
	const selectedModel = inheritedModel === null ? undefined : inheritedModel ?? agent.model;
	if (selectedModel) args.push("--model", selectedModel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: selectedModel,
		step,
	};

	const emitUpdate = () => {
		onStatusUpdate?.(currentResult);
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...buildChildEnvironment(process.env, provider, providerEnvironmentNames),
					PI_SUBAGENT_ACTIVE: "1",
					[SUBAGENT_DEPTH_ENV]: String(getSubagentDepth() + 1),
				},
			});
			let buffer = "";
			let processClosed = false;
			let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
			let abortListener: (() => void) | undefined;

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (msg.provider) currentResult.provider = boundedMetadata(msg.provider);
						if (msg.model) currentResult.model = boundedMetadata(msg.model);
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) {
							currentResult.errorMessage = sanitizeBounded(msg.errorMessage, RESULT_DIAGNOSTIC_CAP, "Error truncated");
						}
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr = appendBounded(
					currentResult.stderr,
					terminalSanitize(redactSensitiveText(data.toString())),
					RESULT_DIAGNOSTIC_CAP,
				);
			});

			proc.on("close", (code, signalName) => {
				processClosed = true;
				if (forceKillTimer) clearTimeout(forceKillTimer);
				if (signal && abortListener) signal.removeEventListener("abort", abortListener);
				if (buffer.trim()) processLine(buffer);
				if (code === null) {
					currentResult.stderr = appendBounded(
						currentResult.stderr,
							`${currentResult.stderr ? "\n" : ""}Subagent process terminated by ${signalName ?? "an unknown signal"}`,
						RESULT_DIAGNOSTIC_CAP,
					);
					resolve(1);
					return;
				}
				resolve(code);
			});

			proc.on("error", (error) => {
				// `close` follows both spawn failures and runtime process errors; let it
				// perform the single cleanup/settlement path.
				currentResult.stderr = appendBounded(
					currentResult.stderr,
					`${currentResult.stderr ? "\n" : ""}${terminalSanitize(redactSensitiveText(error.message))}`,
					RESULT_DIAGNOSTIC_CAP,
				);
			});

			if (signal) {
				abortListener = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					forceKillTimer = setTimeout(() => {
						if (!processClosed) proc.kill("SIGKILL");
					}, 5000);
					forceKillTimer.unref?.();
				};
				if (signal.aborted) abortListener();
				else signal.addEventListener("abort", abortListener, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) {
			currentResult.stopReason = "aborted";
			currentResult.errorMessage = "Subagent was aborted";
		}
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

function getSubagentDepth(): number {
	const parsed = Number.parseInt(process.env[SUBAGENT_DEPTH_ENV] ?? "0", 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function getContextModel(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function selectedProvider(agents: AgentConfig[], agentName: string, ctx: ExtensionContext): string | undefined {
	const configuredModel = agents.find((agent) => agent.name === agentName)?.model;
	if (!configuredModel) return ctx.model?.provider;
	if (configuredModel.includes("/")) return configuredModel.split("/", 1)[0];
	const modelId = configuredModel.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, "");
	const matchingProviders = [...new Set(ctx.modelRegistry.getAll().filter((model) => model.id === modelId).map((model) => model.provider))];
	return matchingProviders.length === 1 ? matchingProviders[0] : ctx.model?.provider;
}

function selectedProviderEnvironmentNames(provider: string | undefined, ctx: ExtensionContext): string[] {
	if (!provider) return [];
	// Registered provider API-key/header templates are the ambient inputs needed
	// by user-defined relays. Provider env stored in auth.json is loaded directly
	// by the child and therefore does not need ambient inheritance.
	return referencedEnvironmentNames(ctx.modelRegistry.getRegisteredProviderConfig(provider));
}

export default function (pi: ExtensionAPI) {
	// Subagents may recursively spawn children until the configured depth.
	// At the maximum depth, this extension is not registered, making that
	// process a leaf. PI_SUBAGENT_ACTIVE remains a marker for compatibility.
	if (getSubagentDepth() >= MAX_SUBAGENT_DEPTH) return;

	const { whileRunning } = createSubagentStatusPublisher(pi);
	const jobs = new Map<string, BackgroundJob>();
	let shuttingDown = false;
	let lifecycleGeneration = 0;
	let activeSubagentSlots = 0;
	type SlotWaiter = {
		resolve: (release: () => void) => void;
		reject: (error: Error) => void;
		signal: AbortSignal;
		onAbort: () => void;
	};
	const slotWaiters: SlotWaiter[] = [];

	const releaseSubagentSlot = () => {
		activeSubagentSlots = Math.max(0, activeSubagentSlots - 1);
		while (slotWaiters.length > 0) {
			const waiter = slotWaiters.shift()!;
			waiter.signal.removeEventListener("abort", waiter.onAbort);
			if (waiter.signal.aborted) continue;
			activeSubagentSlots++;
			waiter.resolve(releaseSubagentSlot);
			break;
		}
	};

	const acquireSubagentSlot = (signal: AbortSignal): Promise<() => void> => {
		if (signal.aborted) return Promise.reject(new Error("Subagent job was canceled while queued"));
		if (activeSubagentSlots < MAX_CONCURRENCY) {
			activeSubagentSlots++;
			return Promise.resolve(releaseSubagentSlot);
		}
		return new Promise((resolve, reject) => {
			const waiter: SlotWaiter = {
				resolve,
				reject,
				signal,
				onAbort: () => {
					const index = slotWaiters.indexOf(waiter);
					if (index >= 0) slotWaiters.splice(index, 1);
					reject(new Error("Subagent job was canceled while queued"));
				},
			};
			slotWaiters.push(waiter);
			signal.addEventListener("abort", waiter.onAbort, { once: true });
		});
	};

	const withSubagentSlot = async <T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> => {
		const release = await acquireSubagentSlot(signal);
		try {
			return await run();
		} finally {
			release();
		}
	};

	const isCurrentRuntime = (job: BackgroundJob, generation = job.runtimeGeneration): boolean =>
		generation === lifecycleGeneration && !shuttingDown;

	const isJobRuntimeCurrent = (job: BackgroundJob, generation: number): boolean =>
		job.runtimeGeneration === generation && generation === lifecycleGeneration;

	const persistJobDefinition = (job: BackgroundJob) => {
		if (job.runtimeGeneration !== lifecycleGeneration || shuttingDown) return;
		const persisted: PersistedJobDefinition = {
			id: job.id,
			mode: job.mode,
			agentScope: job.agentScope,
			projectAgentsDir: job.projectAgentsDir,
			defaultCwd: job.defaultCwd,
			confirmProjectAgents: job.confirmProjectAgents,
			tasks: job.tasks.map(({ agent, title, task, cwd, sessionId, model }) => ({
				agent,
				title,
				task,
				cwd,
				sessionId,
				model,
			})),
			startedAt: job.startedAt,
		};
		pi.appendEntry(JOB_DEFINITION_ENTRY_TYPE, persisted);
	};

	const persistJobState = (job: BackgroundJob, taskIndex?: number) => {
		if (job.runtimeGeneration !== undefined && job.runtimeGeneration !== lifecycleGeneration) return;
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
		pi.appendEntry(JOB_STATE_ENTRY_TYPE, persisted);
	};

	const jobResults = (job: BackgroundJob): SingleResult[] => {
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
				// Delegated prompts and child messages can contain source or credentials.
				// They are unnecessary for background rendering and never enter details.
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
	};

	const taskState = (job: BackgroundJob, task: BackgroundTask): SubagentJobTaskState => {
		if (task.completed) return "succeeded";
		if (task.result && isFailedResult(task.result)) return "failed";
		if (job.status === "running" && task.attempts > 0) return "running";
		if (task.attempts > 0 && task.output && job.status !== "canceled") return "failed";
		return "pending";
	};

	const jobDetails = (job: BackgroundJob): SubagentDetails => ({
		mode: job.mode,
		agentScope: job.agentScope,
		projectAgentsDir: job.projectAgentsDir ? boundedMetadata(job.projectAgentsDir, 2 * 1024) : null,
		results: jobResults(job),
		background: true,
		jobId: job.id,
		jobStatus: job.status,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		tasks: job.tasks.map((task) => ({
			agent: boundedMetadata(task.agent),
			title: boundedMetadata(task.title),
			sessionId: boundedMetadata(task.sessionId),
			attempts: task.attempts,
			completed: task.completed,
			model: task.model ? boundedMetadata(task.model) : undefined,
			state: taskState(job, task),
		})),
	});

	const summarizeJob = (job: BackgroundJob, includeOutput = false): string => {
		const counts = { succeeded: 0, failed: 0, pending: 0, running: 0 };
		for (const task of job.tasks) counts[taskState(job, task)]++;
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

		const failures = job.tasks.filter((task) => taskState(job, task) === "failed");
		for (const [index, task] of failures.slice(0, 5).entries()) {
			const diagnostic = compactDiagnostic(task.output ?? task.result?.errorMessage ?? task.result?.stderr);
			lines.push(`failure ${index + 1}: ${boundedMetadata(task.title)} (${boundedMetadata(task.agent)})${diagnostic ? ` · ${diagnostic}` : ""}`);
		}
		if (failures.length > 5) lines.push(`failures: +${failures.length - 5} more`);

		if (includeOutput) {
			lines.push("", `Task output (opt-in; redacted; max ${STATUS_DETAIL_OUTPUT_CAP / 1024} KB per task, ${STATUS_DETAIL_TOTAL_CAP / 1024} KB total):`);
			for (const [index, task] of job.tasks.entries()) {
				if (!task.output) continue;
				lines.push(`\n### task ${index + 1}: ${boundedMetadata(task.title)} (${boundedMetadata(task.agent)}) · ${taskState(job, task)}`);
				lines.push(sanitizeBounded(task.output, STATUS_DETAIL_OUTPUT_CAP, "Task output truncated"));
			}
			return truncateUtf8(lines.join("\n"), STATUS_DETAIL_TOTAL_CAP, "Detailed status truncated");
		}
		return lines.join("\n");
	};

	const notifySupervisorEvent = (job: BackgroundJob) => {
		if (shuttingDown) return;
		const action = job.status === "completed" ? "Use the results below." : "The job can be resumed with subagent_jobs action=resume.";
		const content = sanitizeBounded(
			[
				`[Subagent supervisor event] Background job ${boundedMetadata(job.id)} is ${boundedMetadata(String(job.status))}.`,
				action,
				"This notification is one-way: do not wait for the child process, and do not assume the child is waiting for you.",
				"",
				summarizeJob(job),
				"",
				"Completed task outputs (bounded for the parent model):",
				...job.tasks.map((task, index) =>
					`\n### task ${index + 1}: ${boundedMetadata(task.title)} (${boundedMetadata(task.agent)}) · ${taskState(job, task)}\n${truncateParallelOutput(task.output ?? "(no output)")}`,
				),
			].join("\n"),
			SUPERVISOR_MESSAGE_CAP,
			"Supervisor message truncated; use subagent_jobs status for task summaries",
		);
		pi.sendMessage(
			{
				customType: "subagent-supervisor",
				content,
				display: true,
				details: jobDetails(job),
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	};

	const runBackgroundJob = async (
		job: BackgroundJob,
		agents: AgentConfig[],
		ctx: ExtensionContext,
		continuation?: string,
	) => {
		if (job.status === "running") return;
		const runGeneration = lifecycleGeneration;
		job.status = "running";
		job.finishedAt = undefined;
		job.runtimeGeneration = runGeneration;
		const controller = new AbortController();
		job.controller = controller;
		persistJobState(job);

		try {
			const executeTask = async (task: BackgroundTask, index: number, prompt: string): Promise<SingleResult> => {
				const isPersistedResume = task.attempts > 0;
				task.attempts++;
				task.completed = false;
				task.output = undefined;
				task.result = undefined;
				if (!isPersistedResume) {
					task.model ??= agents.find((agent) => agent.name === task.agent)?.model ?? getContextModel(ctx);
				}
				if (!isJobRuntimeCurrent(job, runGeneration)) throw new Error("Subagent runtime was retired");
				persistJobState(job, index);
				const selectedModel = isPersistedResume && !task.model ? null : task.model;
				const result = await withSubagentSlot(controller.signal, () =>
					whileRunning(
						task.agent,
						task.title,
						ctx,
						(onStatusUpdate) =>
							runSingleAgent(
								job.defaultCwd,
								agents,
								task.agent,
								prompt,
								task.cwd,
								job.mode === "chain" ? index + 1 : undefined,
								controller.signal,
								task.sessionId,
								selectedModel,
								selectedModel?.includes("/") ? selectedModel.split("/", 1)[0] : selectedProvider(agents, task.agent, ctx),
								selectedProviderEnvironmentNames(selectedModel?.includes("/") ? selectedModel.split("/", 1)[0] : selectedProvider(agents, task.agent, ctx), ctx),
								undefined,
								(results) => ({ ...jobDetails(job), results }),
								(result) => {
									if (!isJobRuntimeCurrent(job, runGeneration)) return;
									const observedModel = effectiveModel(result.provider, result.model);
									if (observedModel && observedModel !== task.model) {
										task.model = observedModel;
										persistJobState(job, index);
									}
									onStatusUpdate(result);
								},
							),
						task.model,
					),
				);
				if (!isJobRuntimeCurrent(job, runGeneration)) return result;
				task.result = result;
				const fullOutput = getResultOutput(result);
				task.output = sanitizeBounded(fullOutput, PERSISTED_TASK_OUTPUT_CAP, "Persisted task output truncated");
				task.model = effectiveModel(result.provider, result.model) ?? task.model;
				task.completed = !isFailedResult(result);
				persistJobState(job, index);
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
				await mapWithConcurrencyLimit(pending, MAX_CONCURRENCY, async ({ task, index }) => {
					const prompt = task.attempts > 0
						? `${continuation?.trim() || "Continue the previous task from its persisted session."}\n\nOriginal task:\n${task.task}`
						: task.task;
					return executeTask(task, index, prompt);
				});
			}

			if (!isJobRuntimeCurrent(job, runGeneration)) return;
			if (controller.signal.aborted && shuttingDown) job.status = "interrupted";
			else if (controller.signal.aborted) job.status = "canceled";
			else if (job.tasks.every((task) => task.completed)) job.status = "completed";
			else job.status = "interrupted";
		} catch (error) {
			if (!isJobRuntimeCurrent(job, runGeneration)) return;
			job.status = shuttingDown ? "interrupted" : controller.signal.aborted ? "canceled" : "interrupted";
			const pending = job.tasks.find((task) => !task.completed);
			if (pending) {
				pending.output = sanitizeBounded(
					error instanceof Error ? error.message : String(error),
					RESULT_DIAGNOSTIC_CAP,
					"Error truncated",
				);
			}
		} finally {
			if (!isJobRuntimeCurrent(job, runGeneration)) return;
			job.finishedAt ??= Date.now();
			persistJobState(job);
			if (isCurrentRuntime(job, runGeneration)) {
				ctx.ui.notify(`Subagent job ${boundedMetadata(job.id)} ${boundedMetadata(String(job.status))}`, job.status === "completed" ? "info" : "warning");
				notifySupervisorEvent(job);
			}
		}
	};

	pi.registerMessageRenderer("subagent-supervisor", (message, _options, theme) =>
		renderSubagentSupervisorMessage(message, theme),
	);

	pi.on("session_start", (_event, ctx) => {
		lifecycleGeneration++;
		shuttingDown = false;
		for (const job of jobs.values()) {
			job.runtimeGeneration = -1;
			job.controller?.abort();
		}
		jobs.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === LEGACY_JOB_ENTRY_TYPE) {
				const data = entry.data as PersistedBackgroundJob | undefined;
				if (!data?.id) continue;
				jobs.set(data.id, {
					...data,
					confirmProjectAgents: data.confirmProjectAgents ?? true,
					status: data.status === "running" || data.status === "canceling" ? "interrupted" : data.status,
					tasks: data.tasks.map((task) => ({ ...task })),
				});
				continue;
			}
			if (entry.customType === JOB_DEFINITION_ENTRY_TYPE) {
				const data = entry.data as PersistedJobDefinition | undefined;
				if (!data?.id) continue;
				jobs.set(data.id, {
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
				const job = data?.id ? jobs.get(data.id) : undefined;
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
		for (const job of jobs.values()) {
			job.runtimeGeneration = lifecycleGeneration;
			if (job.status === "running" || job.status === "canceling") job.status = "interrupted";
		}
	});

	pi.on("session_shutdown", async () => {
		const shutdownGeneration = lifecycleGeneration;
		const completions: Promise<void>[] = [];
		const activeJobs: BackgroundJob[] = [];
		for (const job of jobs.values()) {
			if (job.status === "running" || job.status === "canceling") {
				job.status = "interrupted";
				job.finishedAt = Date.now();
				persistJobState(job);
				activeJobs.push(job);
			}
			if (job.completion) completions.push(job.completion);
		}

		// Persist interruption before aborting. Finalizers may then add task deltas
		// while shutdown waits, but can never write after this lifecycle retires.
		shuttingDown = true;
		for (const job of activeJobs) job.controller?.abort();
		for (const waiter of slotWaiters.splice(0)) {
			waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.reject(new Error("Session is shutting down"));
		}
		if (completions.length > 0) {
			await Promise.race([
				Promise.allSettled(completions),
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
					timer.unref?.();
				}),
			]);
		}
		if (lifecycleGeneration !== shutdownGeneration) return;
		for (const job of activeJobs) {
			job.status = "interrupted";
			job.finishedAt ??= Date.now();
			persistJobState(job);
			// Retire this job even if other shutdown hooks start a replacement
			// session before this hook returns.
			job.runtimeGeneration = -1;
		}
		lifecycleGeneration++;
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		renderShell: subagentTimelineRenderer.renderShell,
		renderCall: subagentTimelineRenderer.renderCall,
		renderResult: subagentTimelineRenderer.renderResult,
		description: [
			"Start specialized subagents with isolated context and persistent resumable child sessions.",
			"Background mode is the default: it returns a job id immediately so you must continue helping the user instead of polling or waiting.",
			"Each call may start one independent subagent; call this tool again later to create more one by one.",
			"Batch parallel and sequential chain modes are also supported.",
			"Completion or interruption is delivered automatically as a steering message and triggers the main agent when idle.",
			"Use subagent_jobs to inspect, resume, or cancel supervised jobs.",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			if (agentScope !== "user" && !ctx.isProjectTrusted()) {
				return {
					content: [{ type: "text", text: "Project-local agents require a trusted project." }],
					details: {
						mode: "single" as const,
						agentScope,
						projectAgentsDir: null,
						results: [],
					},
					isError: true,
				};
			}
			const discovery = discoverAgents(ctx.cwd, agentScope, ctx.cwd);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const invalidBatchTitle = [...(params.chain ?? []), ...(params.tasks ?? [])]
				.some((item) => !item.title.trim());
			const hasSingle = Boolean(params.agent && params.task && params.title?.trim());
			const incompleteSingle = Boolean(params.agent || params.task || params.title) && !hasSingle;
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1 || incompleteSingle || invalidBatchTitle) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode and a concise title for every subagent.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => boundedMetadata(a.name)).join(", ");
					const dir = discovery.projectAgentsDir ? quoteExactPath(discovery.projectAgentsDir) : "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.background !== false) {
				const mode: SubagentMode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
				const requested = hasChain
					? params.chain!
					: hasTasks
						? params.tasks!
						: [{ agent: params.agent!, title: params.title!, task: params.task!, cwd: params.cwd }];

				if (requested.length > MAX_PARALLEL_TASKS) {
					return {
						content: [{ type: "text", text: `Too many background tasks (${requested.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
						details: makeDetails(mode)([]),
					};
				}

				const unknown = requested.map((item) => item.agent).filter((name) => !agents.some((agent) => agent.name === name));
				if (unknown.length > 0) {
					return {
						content: [{ type: "text", text: `Unknown agents: ${[...new Set(unknown)].join(", ")}` }],
						details: makeDetails(mode)([]),
					};
				}

				const jobId = `sub-${randomUUID()}`;
				const job: BackgroundJob = {
					id: jobId,
					runtimeGeneration: lifecycleGeneration,
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					defaultCwd: ctx.cwd,
					confirmProjectAgents,
					tasks: requested.map((item, index) => ({
						agent: item.agent,
						title: item.title.trim(),
						task: item.task,
						cwd: item.cwd,
						sessionId: `${jobId}-${index + 1}`,
						attempts: 0,
						completed: false,
						model: agents.find((agent) => agent.name === item.agent)?.model ?? getContextModel(ctx),
					})),
					status: "interrupted",
					startedAt: Date.now(),
				};
				jobs.set(job.id, job);
				persistJobDefinition(job);
				persistJobState(job);
				job.completion = runBackgroundJob(job, agents, ctx);

				return {
					content: [{
						type: "text",
						text: `Background subagent job started: ${job.id}\n${requested.length} task(s) are supervised. Do not wait or poll; continue helping the user. Completion/interruption will be delivered automatically.`,
					}],
					details: jobDetails(job),
				};
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const slotSignal = signal ?? new AbortController().signal;
					const result = await withSubagentSlot(slotSignal, () =>
						whileRunning(
							step.agent,
							step.title,
							ctx,
							(onStatusUpdate) =>
								runSingleAgent(
									ctx.cwd,
									agents,
									step.agent,
									taskWithContext,
									step.cwd,
									i + 1,
									signal,
									undefined,
									agents.find((agent) => agent.name === step.agent)?.model ?? getContextModel(ctx),
									selectedProvider(agents, step.agent, ctx),
									selectedProviderEnvironmentNames(selectedProvider(agents, step.agent, ctx), ctx),
									chainUpdate,
									makeDetails("chain"),
									onStatusUpdate,
								),
							agents.find((agent) => agent.name === step.agent)?.model ?? getContextModel(ctx),
						),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${boundedMetadata(step.agent)}): ${sanitizeBounded(errorMsg, PER_TASK_OUTPUT_CAP, "Error output truncated")}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const slotSignal = signal ?? new AbortController().signal;
					const result = await withSubagentSlot(slotSignal, () =>
						whileRunning(
							t.agent,
							t.title,
							ctx,
							(onStatusUpdate) =>
								runSingleAgent(
									ctx.cwd,
									agents,
									t.agent,
									t.task,
									t.cwd,
									undefined,
									signal,
									undefined,
									agents.find((agent) => agent.name === t.agent)?.model ?? getContextModel(ctx),
									selectedProvider(agents, t.agent, ctx),
									selectedProviderEnvironmentNames(selectedProvider(agents, t.agent, ctx), ctx),
									// Per-task update callback
									(partial) => {
										if (partial.details?.results[0]) {
											allResults[index] = partial.details.results[0];
											emitParallelUpdate();
										}
									},
									makeDetails("parallel"),
									onStatusUpdate,
								),
							agents.find((agent) => agent.name === t.agent)?.model ?? getContextModel(ctx),
						),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${boundedMetadata(r.agent)}] ${boundedMetadata(status)}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const slotSignal = signal ?? new AbortController().signal;
				const result = await withSubagentSlot(slotSignal, () =>
					whileRunning(
						params.agent!,
						params.title,
						ctx,
						(onStatusUpdate) =>
							runSingleAgent(
								ctx.cwd,
								agents,
								params.agent!,
								params.task!,
								params.cwd,
								undefined,
								signal,
								undefined,
								agents.find((agent) => agent.name === params.agent)?.model ?? getContextModel(ctx),
								selectedProvider(agents, params.agent!, ctx),
								selectedProviderEnvironmentNames(selectedProvider(agents, params.agent!, ctx), ctx),
								onUpdate,
								makeDetails("single"),
								onStatusUpdate,
							),
						agents.find((agent) => agent.name === params.agent)?.model ?? getContextModel(ctx),
					),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

	});

	pi.registerTool({
		name: "subagent_jobs",
		label: "Subagent Jobs",
		renderShell: subagentJobsRenderer.renderShell,
		renderCall: subagentJobsRenderer.renderCall,
		renderResult: subagentJobsRenderer.renderResult,
		description: [
			"Manage supervised background subagent jobs.",
			"Use list/status to inspect without waiting, resume to continue an interrupted child from its persisted session, and cancel to stop it.",
			"Status is compact by default. Set includeOutput=true only for bounded diagnostic task output.",
			"Never poll a running job repeatedly; completion and interruption notifications are automatic.",
		].join(" "),
		parameters: SubagentJobsParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "list") {
				const ordered = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
				const listed = ordered.slice(0, 50);
				return {
					content: [{
						type: "text",
						text: listed.length > 0
							? `${listed.map((job) => summarizeJob(job)).join("\n\n---\n\n")}${ordered.length > listed.length ? `\n\n${ordered.length - listed.length} older job(s) omitted.` : ""}`
							: "No supervised subagent jobs in this session.",
					}],
					details: { jobs: listed.map(jobDetails) },
				};
			}

			if (!params.jobId) {
				return {
					content: [{ type: "text", text: `action=${params.action} requires jobId.` }],
					details: { jobs: [] },
					isError: true,
				};
			}

			const job = jobs.get(params.jobId);
			if (!job) {
				return {
					content: [{ type: "text", text: `Unknown subagent job: ${params.jobId}` }],
					details: { jobs: [] },
					isError: true,
				};
			}

			if (params.action === "status") {
				return {
					content: [{ type: "text", text: summarizeJob(job, params.includeOutput === true) }],
					details: jobDetails(job),
				};
			}

			if (params.action === "cancel") {
				if (job.status !== "running" && job.status !== "canceling") {
					return {
						content: [{ type: "text", text: `Job ${job.id} is ${job.status}; there is no running process to cancel.` }],
						details: jobDetails(job),
					};
				}
				job.status = "canceling";
				persistJobState(job);
				job.controller?.abort();
				return {
					content: [{ type: "text", text: `Cancellation requested for ${job.id}. The supervisor will notify the main agent when shutdown completes.` }],
					details: jobDetails(job),
				};
			}

			if (job.status === "running" || job.status === "canceling") {
				return {
					content: [{ type: "text", text: `Job ${job.id} is already ${job.status}. Do not wait or poll it.` }],
					details: jobDetails(job),
				};
			}
			if (job.status === "completed") {
				return {
					content: [{ type: "text", text: `Job ${job.id} is already completed.\n\n${summarizeJob(job)}` }],
					details: jobDetails(job),
				};
			}

			// ctx.isProjectTrusted() applies only to ctx.cwd and says nothing about
			// an arbitrary cwd loaded from persisted job data. Pi exposes no
			// arbitrary-path temporary/override trust query to extensions, so every
			// project-agent resume requires an exact-path interactive approval.
			if (job.agentScope !== "user") {
				const executionPaths = [...new Set(job.tasks.map((task) => task.cwd ?? job.defaultCwd))];
				const quotedExecutionPaths = executionPaths.map(quoteExactPath);
				if (ctx.mode !== "tui" || !ctx.hasUI) {
					return {
						content: [{ type: "text", text: `Cannot resume ${job.id} noninteractively; project-local job path approval is required for: ${quotedExecutionPaths.join(", ")}` }],
						details: jobDetails(job),
						isError: true,
					};
				}
				const approved = await ctx.ui.confirm(
					"Resume project job at exact path?",
					`Persisted project-agent source cwd: ${quoteExactPath(job.defaultCwd)}\nPersisted child execution path${quotedExecutionPaths.length === 1 ? "" : "s"}:\n${quotedExecutionPaths.map((value) => `- ${value}`).join("\n")}\n\nThis approval is required on every resume and applies only to this attempt. Project agent files may have changed.`,
				);
				if (!approved) {
					return {
						content: [{ type: "text", text: `Canceled resume for ${job.id}; persisted project paths were not approved.` }],
						details: jobDetails(job),
						isError: true,
					};
				}
			}
			const discovery = discoverAgents(job.defaultCwd, job.agentScope, job.defaultCwd);
			if (job.agentScope !== "user" && job.confirmProjectAgents && ctx.mode === "tui" && ctx.hasUI) {
				const projectAgents = [...new Set(job.tasks.map((task) => task.agent))]
					.map((name) => discovery.agents.find((agent) => agent.name === name))
					.filter((agent): agent is AgentConfig => agent?.source === "project");
				if (projectAgents.length > 0) {
					const ok = await ctx.ui.confirm(
						"Resume project-local agents?",
						`Agents: ${projectAgents.map((agent) => boundedMetadata(agent.name)).join(", ")}\nSource: ${discovery.projectAgentsDir ? quoteExactPath(discovery.projectAgentsDir) : "(unknown)"}\n\nAgent files may have changed since this job started.`,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: `Canceled resume for ${job.id}: project-local agents were not approved.` }],
							details: jobDetails(job),
							isError: true,
						};
					}
				}
			}
			const missing = job.tasks.map((task) => task.agent).filter((name) => !discovery.agents.some((agent) => agent.name === name));
			if (missing.length > 0) {
				return {
					content: [{ type: "text", text: `Cannot resume ${job.id}; missing agents: ${[...new Set(missing)].join(", ")}` }],
					details: jobDetails(job),
					isError: true,
				};
			}

			job.completion = runBackgroundJob(job, discovery.agents, ctx, params.instruction);
			return {
				content: [{
					type: "text",
					text: `Resumed ${job.id} from its persisted child session(s). Return to the user now; completion/interruption notification is automatic.`,
				}],
				details: jobDetails(job),
			};
		},
	});
}
