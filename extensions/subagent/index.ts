import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { loadSubagentConfig } from "./config.ts";
import { JobStore, type JobItem } from "./jobs.ts";
import { getContextModel, isDepthLimitReached, providerEnvNames, runChild, selectedProvider } from "./process.ts";
import { SubagentJobsParams, SubagentParams } from "./schema.ts";
import { quoteExactPath } from "./security.ts";
import { Semaphore } from "./slots.ts";
import { createStatusPublisher } from "./status.ts";
import { PER_TASK_OUTPUT_CAP, boundedMetadata, getFinalOutput, getResultOutput, isFailedResult, sanitizeBounded, truncateTaskOutput } from "./text.ts";
import {
	renderSupervisorMessage,
	subagentJobsRenderer,
	subagentTimelineRenderer,
} from "./timeline.ts";
import type { SingleResult, SubagentDetails, SubagentMode } from "./types.ts";

const DEFAULT_AGENT_LABEL = "default";

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

function childInvocationArgs(
	agents: AgentConfig[],
	agentName: string | undefined,
	ctx: ExtensionContext,
) {
	const agent = agentName ? agents.find((a) => a.name === agentName) : undefined;
	const model = agent?.model ?? getContextModel(ctx);
	const provider = selectedProvider(agents, agentName, ctx);
	return {
		agent,
		model,
		provider,
		providerEnvNames: providerEnvNames(provider, ctx),
	};
}

function unknownAgentNames(items: JobItem[], agents: AgentConfig[]): string[] {
	const unknown = items
		.map((item) => item.agent)
		.filter((name): name is string => Boolean(name))
		.filter((name) => !agents.some((agent) => agent.name === name));
	return [...new Set(unknown)];
}

function projectAgentsRequested(items: JobItem[], agents: AgentConfig[]): AgentConfig[] {
	const requested = new Set(items.map((item) => item.agent).filter((name): name is string => Boolean(name)));
	return [...requested]
		.map((name) => agents.find((agent) => agent.name === name))
		.filter((agent): agent is AgentConfig => agent?.source === "project");
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
			"If agent is omitted, the child runs with pi defaults (current model, default tools).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const detailsFor =
				(mode: SubagentMode, projectAgentsDir: string | null = null) =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir,
					results,
				});

			if (agentScope !== "user" && !ctx.isProjectTrusted()) {
				return {
					content: [{ type: "text", text: "Project-local agents require a trusted project." }],
					details: detailsFor("single")([]),
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
			const hasSingle = Boolean(params.task && params.title?.trim());
			const incompleteSingle = Boolean(params.agent || params.task || params.title) && !hasSingle;
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			if (modeCount !== 1 || incompleteSingle || invalidBatchTitle) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [{
						type: "text",
						text: `Invalid parameters. Provide exactly one mode and a concise title for every subagent.\nAvailable agents: ${available}`,
					}],
					details: detailsFor("single")([]),
				};
			}

			const mode: SubagentMode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
			const requested: JobItem[] = hasChain
				? params.chain!
				: hasTasks
					? params.tasks!
					: [{ agent: params.agent, title: params.title!, task: params.task!, cwd: params.cwd }];

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedProjectAgents = projectAgentsRequested(requested, agents);
				if (requestedProjectAgents.length > 0) {
					const names = requestedProjectAgents.map((a) => boundedMetadata(a.name)).join(", ");
					const dir = discovery.projectAgentsDir ? quoteExactPath(discovery.projectAgentsDir) : "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: detailsFor(mode, discovery.projectAgentsDir)([]),
						};
					}
				}
			}

			const unknown = unknownAgentNames(requested, agents);
			if (unknown.length > 0) {
				return {
					content: [{ type: "text", text: `Unknown agents: ${unknown.join(", ")}` }],
					details: detailsFor(mode, discovery.projectAgentsDir)([]),
					isError: true,
				};
			}

			notifyConfigWarning(ctx);

			if (params.background !== false) {
				const job = store.start(
					{
						mode,
						agentScope,
						projectAgentsDir: discovery.projectAgentsDir,
						confirmProjectAgents,
						items: requested.map((item) => ({ ...item, title: item.title.trim() })),
					},
					agents,
					ctx,
				);
				return {
					content: [{
						type: "text",
						text: `Background subagent job started: ${job.id}\n${requested.length} task(s) are supervised. Do not wait or poll; continue helping the user. Completion/interruption will be delivered automatically.`,
					}],
					details: store.details(job),
				};
			}

			const runOne = (
				item: JobItem,
				step: number | undefined,
				taskOnUpdate: ((partial: AgentToolResult<SubagentDetails>) => void) | undefined,
				makeDetails: (results: SingleResult[]) => SubagentDetails,
			): Promise<SingleResult> => {
				const invocation = childInvocationArgs(agents, item.agent, ctx);
				const slotSignal = signal ?? new AbortController().signal;
				return semaphore.with(slotSignal, () =>
					whileRunning(
						item.agent ?? DEFAULT_AGENT_LABEL,
						item.title,
						ctx,
						(onStatusUpdate) =>
							runChild({
								defaultCwd: ctx.cwd,
								agent: invocation.agent,
								agentName: item.agent ?? DEFAULT_AGENT_LABEL,
								task: item.task,
								cwd: item.cwd,
								step,
								signal,
								inheritedModel: invocation.model,
								provider: invocation.provider,
								providerEnvNames: invocation.providerEnvNames,
								onUpdate: taskOnUpdate,
								makeDetails,
								onStatusUpdate,
							}),
						invocation.model,
					),
				);
			};

			if (mode === "chain") {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain!.length; i++) {
					const step = params.chain![i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					const chainUpdate = onUpdate
						? (partial: AgentToolResult<SubagentDetails>) => {
							const currentResult = partial.details?.results[0];
							if (currentResult) {
								onUpdate({
									content: partial.content,
									details: detailsFor("chain", discovery.projectAgentsDir)([...results, currentResult]),
								});
							}
						}
						: undefined;

					const result = await runOne({ ...step, task: taskWithContext }, i + 1, chainUpdate, detailsFor("chain", discovery.projectAgentsDir));
					results.push(result);

					if (isFailedResult(result)) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${boundedMetadata(step.agent ?? DEFAULT_AGENT_LABEL)}): ${sanitizeBounded(errorMsg, PER_TASK_OUTPUT_CAP, "Error output truncated")}` }],
							details: detailsFor("chain", discovery.projectAgentsDir)(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: detailsFor("chain", discovery.projectAgentsDir)(results),
				};
			}

			if (mode === "parallel") {
				const tasks = params.tasks!;
				const allResults: SingleResult[] = new Array(tasks.length);
				for (let i = 0; i < tasks.length; i++) {
					allResults[i] = {
						agent: tasks[i].agent ?? DEFAULT_AGENT_LABEL,
						agentSource: "unknown",
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
							details: detailsFor("parallel", discovery.projectAgentsDir)([...allResults]),
						});
					}
				};

				const results = await Promise.all(tasks.map(async (t, index) => {
					const result = await runOne(t, undefined, (partial) => {
						if (partial.details?.results[0]) {
							allResults[index] = partial.details.results[0];
							emitParallelUpdate();
						}
					}, detailsFor("parallel", discovery.projectAgentsDir));
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				}));

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateTaskOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${boundedMetadata(r.agent)}] ${boundedMetadata(status)}\n\n${output}`;
				});
				return {
					content: [{
						type: "text",
						text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
					}],
					details: detailsFor("parallel", discovery.projectAgentsDir)(results),
				};
			}

			const result = await runOne(
				{ agent: params.agent, title: params.title!, task: params.task!, cwd: params.cwd },
				undefined,
				onUpdate,
				detailsFor("single", discovery.projectAgentsDir),
			);
			if (isFailedResult(result)) {
				const errorMsg = getResultOutput(result);
				return {
					content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
					details: detailsFor("single", discovery.projectAgentsDir)([result]),
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
				details: detailsFor("single", discovery.projectAgentsDir)([result]),
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
			"Status is compact by default. Set includeOutput=true only for bounded diagnostic task output.",
			"Never poll a running job repeatedly; completion and interruption notifications are automatic.",
		].join(" "),
		parameters: SubagentJobsParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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

			if (job.agentScope !== "user") {
				const executionPaths = [...new Set(job.tasks.map((task) => task.cwd ?? job.defaultCwd))];
				const quotedExecutionPaths = executionPaths.map(quoteExactPath);
				if (ctx.mode !== "tui" || !ctx.hasUI) {
					return {
						content: [{ type: "text", text: `Cannot resume ${job.id} noninteractively; project-local job path approval is required for: ${quotedExecutionPaths.join(", ")}` }],
						details: store.details(job),
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
						details: store.details(job),
						isError: true,
					};
				}
			}
			const discovery = discoverAgents(job.defaultCwd, job.agentScope, job.defaultCwd);
			if (job.agentScope !== "user" && job.confirmProjectAgents && ctx.mode === "tui" && ctx.hasUI) {
				const projectAgents = [...new Set(job.tasks.map((task) => task.agent).filter((name): name is string => Boolean(name)))]
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
							details: store.details(job),
							isError: true,
						};
					}
				}
			}
			const missing = job.tasks
				.map((task) => task.agent)
				.filter((name): name is string => Boolean(name))
				.filter((name) => !discovery.agents.some((agent) => agent.name === name));
			if (missing.length > 0) {
				return {
					content: [{ type: "text", text: `Cannot resume ${job.id}; missing agents: ${[...new Set(missing)].join(", ")}` }],
					details: store.details(job),
					isError: true,
				};
			}

			store.resume(job, discovery.agents, ctx, params.instruction);
			return {
				content: [{
					type: "text",
					text: `Resumed ${job.id} from its persisted child session(s). Return to the user now; completion/interruption notification is automatic.`,
				}],
				details: store.details(job),
			};
		},
	});
}
