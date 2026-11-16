import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadSubagentConfig } from "./config.ts";
import { contextWindowFor, knownToolCatalog, parseModelOverride, resolveChildInvocation } from "./invocation.ts";
import { JobStore, type JobItem } from "./jobs.ts";
import { getContextModel, isDepthLimitReached, runChild } from "./process.ts";
import { SubagentJobsParams, SubagentParams } from "./schema.ts";
import { Semaphore } from "./slots.ts";
import { createStatusPublisher } from "./status.ts";
import { MAX_INSTRUCTION_CHARS, MAX_TASK_CHARS, PER_TASK_OUTPUT_CAP, boundedMetadata, clampTitle, getFinalOutput, getResultOutput, isFailedResult, sanitizeBounded, truncateTaskOutput } from "./text.ts";
import {
	renderSupervisorMessage,
	subagentJobsRenderer,
	subagentTimelineRenderer,
} from "./timeline.ts";
import type { SingleResult, SubagentDetails, SubagentMode } from "./types.ts";

let lastConfigWarning: string | undefined;

function concurrency(): number {
	return loadSubagentConfig().concurrency;
}

function notifyConfigWarning(ctx: ExtensionContext): void {
	const warning = loadSubagentConfig().warning;
	if (warning && warning !== lastConfigWarning) {
		lastConfigWarning = warning;
		ctx.ui.notify(warning, "warning");
	}
}

export default function (pi: ExtensionAPI) {
	if (isDepthLimitReached()) return;

	const { whileRunning } = createStatusPublisher(pi);
	const semaphore = new Semaphore(concurrency);
	const store = new JobStore(pi, semaphore, whileRunning);

	pi.registerMessageRenderer("subagent-supervisor", (message, _options, theme) =>
		renderSupervisorMessage(message, theme),
	);

	pi.on("session_start", (_event, ctx) => {
		store.restore(ctx);
	});

	pi.on("session_shutdown", async () => {
		await store.shutdown();
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
			"Use subagent_jobs to steer a running child or inspect, resume, and cancel supervised jobs.",
			"An explicit model, thinking, or tools override that cannot be honored fails the call instead of falling back silently.",
			"Omit tools to inherit the child's complete default tool set; pass tools only to deliberately restrict permissions, for example a read-only reviewer.",
			"Keep every title to 2-5 words and never prefix it with the tool name; it is the whole label in the footer row.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const detailsFor = (mode: SubagentMode) =>
				(results: SingleResult[]): SubagentDetails => ({ mode, results });

			const knownTools = knownToolCatalog(pi);
			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const invalidBatchItem = [...(params.chain ?? []), ...(params.tasks ?? [])]
				.some((item) => !item.title?.trim() || !item.task?.trim());
			const hasSingle = Boolean(params.task?.trim() && params.title?.trim());
			const incompleteSingle = Boolean(params.task || params.title) && !hasSingle;
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			if (modeCount !== 1 || incompleteSingle || invalidBatchItem) {
				return {
					content: [{
						type: "text",
						text: "Invalid parameters. Provide exactly one mode and a concise title for every subagent.",
					}],
					details: detailsFor("single")([]),
				};
			}

			const mode: SubagentMode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
			const sourceItems: JobItem[] = hasChain
				? params.chain!
				: hasTasks
					? params.tasks!
					: [{ title: params.title!, task: params.task!, cwd: params.cwd }];
			const requested: JobItem[] = sourceItems.map((item) => ({
				...item,
				title: clampTitle(item.title),
				task: item.task.trim(),
				model: item.model ?? params.model,
				thinking: item.thinking ?? params.thinking,
				tools: item.tools ?? params.tools,
				systemPrompt: item.systemPrompt ?? params.systemPrompt,
			}));

			notifyConfigWarning(ctx);

			const oversized = requested.find((item) => item.task.length > MAX_TASK_CHARS);
			if (oversized) {
				return {
					content: [{
						type: "text",
						text: `Task is too long (${oversized.task.length} characters, max ${MAX_TASK_CHARS}); put it in a file and point the subagent at it instead.`,
					}],
					details: detailsFor(mode)([]),
					isError: true,
				};
			}

			if (params.background !== false) {
				const job = store.start({ mode, items: requested }, ctx);
				return {
					content: [{
						type: "text",
						text: `Background subagent job started: ${job.id}\n${requested.length} task(s) are supervised. Do not wait or poll; continue helping the user. Completion/interruption will be delivered automatically.`,
					}],
					details: store.details(job),
				};
			}

			// Foreground runs resolve every override before the first child starts, so a bad model or
			// tool list cannot fail after an earlier step already spent tokens.
			const invocations = params.background === false
				? requested.map((item) => resolveChildInvocation(ctx, item, knownTools))
				: [];

			const runOne = (
				item: JobItem,
				index: number,
				step: number | undefined,
				taskOnUpdate: ((partial: AgentToolResult<SubagentDetails>) => void) | undefined,
				makeDetails: (results: SingleResult[]) => SubagentDetails,
			): Promise<SingleResult> => {
				const invocation = invocations[index]!;
				const inheritedModel = invocation.model ?? getContextModel(ctx);
				const slotSignal = signal ?? new AbortController().signal;
				return semaphore.with(slotSignal, () =>
					whileRunning(
						item.title,
						ctx,
						(onStatusUpdate) =>
							runChild({
								defaultCwd: ctx.cwd,
								task: item.task,
								cwd: item.cwd,
								step,
								signal,
								inheritedModel,
								provider: invocation.provider,
								providerEnvNames: invocation.providerEnvNames,
								thinking: invocation.thinking,
								tools: invocation.tools,
								systemPrompt: invocation.systemPrompt,
								onUpdate: taskOnUpdate,
								makeDetails,
								onStatusUpdate,
							}),
						inheritedModel,
						invocation.thinking,
					),
				);
			};

			if (mode === "chain") {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < requested.length; i++) {
					const step = requested[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					const chainUpdate = onUpdate
						? (partial: AgentToolResult<SubagentDetails>) => {
							const currentResult = partial.details?.results[0];
							if (currentResult) {
								onUpdate({
									content: partial.content,
									details: detailsFor("chain")([...results, currentResult]),
								});
							}
						}
						: undefined;

					const result = await runOne({ ...step, task: taskWithContext }, i, i + 1, chainUpdate, detailsFor("chain"));
					results.push(result);

					if (isFailedResult(result)) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1}: ${sanitizeBounded(errorMsg, PER_TASK_OUTPUT_CAP, "Error output truncated")}` }],
							details: detailsFor("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: detailsFor("chain")(results),
				};
			}

			if (mode === "parallel") {
				const tasks = requested;
				const allResults: SingleResult[] = new Array(tasks.length);
				for (let i = 0; i < tasks.length; i++) {
					allResults[i] = {
						task: tasks[i].task,
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
							content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
							details: detailsFor("parallel")([...allResults]),
						});
					}
				};

				const results = await Promise.all(tasks.map(async (t, index) => {
					const result = await runOne(t, index, undefined, (partial) => {
						if (partial.details?.results[0]) {
							allResults[index] = partial.details.results[0];
							emitParallelUpdate();
						}
					}, detailsFor("parallel"));
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				}));

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r, index) => {
					const output = truncateTaskOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### ${boundedMetadata(tasks[index].title)} ${boundedMetadata(status)}\n\n${output}`;
				});
				return {
					content: [{
						type: "text",
						text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
					}],
					details: detailsFor("parallel")(results),
				};
			}

			const result = await runOne(
				requested[0],
				0,
				undefined,
				onUpdate,
				detailsFor("single"),
			);
			if (isFailedResult(result)) {
				const errorMsg = getResultOutput(result);
				return {
					content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
					details: detailsFor("single")([result]),
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
				details: detailsFor("single")([result]),
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
			"Use steer to redirect a running child, list/status to inspect without waiting, resume to continue an interrupted child from its persisted session, and cancel to stop it.",
			"For parallel jobs, steer accepts a zero-based taskIndex; it may be omitted when exactly one child is running.",
			"Resume accepts optional model, thinking, and tools overrides for every task of the job; they are validated and fail the call when they cannot be honored.",
			"Status is compact by default. Set includeOutput=true only for bounded diagnostic task output.",
			"Never poll a running job repeatedly; completion and interruption notifications are automatic.",
		].join(" "),
		parameters: SubagentJobsParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resumeOnly = ["model", "thinking", "tools"] as const;
			if (params.action !== "resume" && resumeOnly.some((field) => params[field] !== undefined)) {
				return {
					content: [{ type: "text", text: `model, thinking, and tools overrides are only valid with action=resume; action=${params.action} does not accept them.` }],
					details: { jobs: [] },
					isError: true,
				};
			}

			if (params.action === "list") {
				const listed = store.list().slice(0, 50);
				return {
					content: [{ type: "text", text: store.summarizeList() }],
					details: { jobs: listed.map((job) => store.details(job)) },
				};
			}

			if (!params.jobId) {
				return {
					content: [{ type: "text", text: `action=${params.action} requires jobId.` }],
					details: { jobs: [] },
					isError: true,
				};
			}

			const job = store.get(params.jobId);
			if (!job) {
				return {
					content: [{ type: "text", text: `Unknown subagent job: ${params.jobId}` }],
					details: { jobs: [] },
					isError: true,
				};
			}

			if (params.action === "status") {
				return {
					content: [{ type: "text", text: store.summarize(job, params.includeOutput === true) }],
					details: store.details(job),
				};
			}

			if (params.action === "steer") {
				const instruction = params.instruction?.trim();
				if (!instruction) {
					return {
						content: [{ type: "text", text: "action=steer requires a non-empty instruction." }],
						details: store.details(job),
						isError: true,
					};
				}
				if (instruction.length > MAX_INSTRUCTION_CHARS) {
					return {
						content: [{ type: "text", text: `Instruction is too long (${instruction.length} characters, max ${MAX_INSTRUCTION_CHARS}).` }],
						details: store.details(job),
						isError: true,
					};
				}
				const outcome = await store.steer(job, params.taskIndex, instruction);
				return {
					content: [{ type: "text", text: outcome.text }],
					details: store.details(job),
					isError: !outcome.ok,
				};
			}

			if (params.action === "cancel") {
				if (job.status !== "running" && job.status !== "canceling") {
					return {
						content: [{ type: "text", text: `Job ${job.id} is ${job.status}; there is no running process to cancel.` }],
						details: store.details(job),
					};
				}
				store.cancel(job);
				return {
					content: [{ type: "text", text: `Cancellation requested for ${job.id}. The supervisor will notify the main agent when shutdown completes.` }],
					details: store.details(job),
				};
			}

			if (job.status === "running" || job.status === "canceling") {
				return {
					content: [{ type: "text", text: `Job ${job.id} is already ${job.status}. Do not wait or poll it.` }],
					details: store.details(job),
				};
			}
			if (job.status === "completed") {
				return {
					content: [{ type: "text", text: `Job ${job.id} is already completed.\n\n${store.summarize(job)}` }],
					details: store.details(job),
				};
			}

			const switchesModel = params.model !== undefined;
			if (switchesModel || params.thinking !== undefined || params.tools !== undefined) {
				const invocation = resolveChildInvocation(
					ctx,
					{ model: params.model, thinking: params.thinking, tools: params.tools },
					knownToolCatalog(pi),
				);
				if (switchesModel) {
					const targetModel = invocation.model ?? getContextModel(ctx);
					const contextWindow = targetModel ? contextWindowFor(ctx, targetModel) : undefined;
					if (contextWindow !== undefined) {
						for (const [index, task] of job.tasks.entries()) {
							const used = task.contextTokens ?? task.result?.usage.contextTokens ?? 0;
							if (used > contextWindow) {
								return {
									content: [{
										type: "text",
										text: `Cannot resume ${job.id} on ${targetModel}: task ${index + 1} (${boundedMetadata(task.title)}) last used ${used} context tokens and ${targetModel} has a context window of ${contextWindow} tokens. Start a fresh subagent instead of resuming this job.`,
									}],
									details: store.details(job),
									isError: true,
								};
							}
						}
					}
					for (const task of job.tasks) task.model = targetModel;
				}
				if (params.thinking !== undefined || (params.model && parseModelOverride(params.model).thinking !== undefined)) {
					for (const task of job.tasks) task.thinking = invocation.thinking;
				}
				if (params.tools !== undefined) {
					for (const task of job.tasks) task.tools = invocation.tools;
				}
			}

			store.resume(job, ctx, params.instruction);
			const models = [...new Set(job.tasks.map((task) => task.model ?? "the inherited parent model"))];
			return {
				content: [{
					type: "text",
					text: `Resumed ${job.id} from its persisted child session(s) using ${models.join(", ")}. Return to the user now; completion/interruption notification is automatic.`,
				}],
				details: store.details(job),
			};
		},
	});
}
