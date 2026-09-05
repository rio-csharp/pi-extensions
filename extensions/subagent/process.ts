import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { buildChildEnvironment, referencedEnvironmentNames, terminalSanitize } from "./security.ts";
import {
	RESULT_DIAGNOSTIC_CAP,
	appendBounded,
	boundedMetadata,
	redactSensitiveText,
	sanitizeBounded,
} from "./text.ts";
import type { SingleResult, SubagentDetails } from "./types.ts";

const MAX_SUBAGENT_DEPTH = 5;
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const RPC_RESPONSE_TIMEOUT_MS = 30_000;
const GRACEFUL_CLOSE_MS = 5_000;

export function getSubagentDepth(): number {
	const parsed = Number.parseInt(process.env[SUBAGENT_DEPTH_ENV] ?? "0", 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function isDepthLimitReached(): boolean {
	return getSubagentDepth() >= MAX_SUBAGENT_DEPTH;
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

export function getContextModel(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

export function selectedProvider(agents: AgentConfig[], agentName: string | undefined, ctx: ExtensionContext): string | undefined {
	const configuredModel = agentName ? agents.find((agent) => agent.name === agentName)?.model : undefined;
	if (!configuredModel) return ctx.model?.provider;
	if (configuredModel.includes("/")) return configuredModel.split("/", 1)[0];
	const modelId = configuredModel.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, "");
	const matchingProviders = [...new Set(ctx.modelRegistry.getAll().filter((model) => model.id === modelId).map((model) => model.provider))];
	return matchingProviders.length === 1 ? matchingProviders[0] : ctx.model?.provider;
}

export function providerEnvNames(provider: string | undefined, ctx: ExtensionContext): string[] {
	if (!provider) return [];
	return referencedEnvironmentNames(ctx.modelRegistry.getRegisteredProviderConfig(provider));
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

const liveChildren = new Set<ChildProcess>();
let sweepRegistered = false;

// session_shutdown cannot run when pi is killed; without this sweep, children would keep spending money as orphans.
function trackChild(proc: ChildProcess): void {
	liveChildren.add(proc);
	if (!sweepRegistered) {
		sweepRegistered = true;
		process.on("exit", () => {
			for (const child of liveChildren) child.kill("SIGTERM");
		});
	}
	proc.once("close", () => liveChildren.delete(proc));
}

export interface ChildControl {
	steer(instruction: string): Promise<void>;
}

export interface RunChildOptions {
	defaultCwd: string;
	agent?: AgentConfig;
	agentName: string;
	task: string;
	cwd?: string;
	step?: number;
	signal?: AbortSignal;
	sessionId?: string;
	inheritedModel?: string | null;
	provider?: string;
	providerEnvNames?: readonly string[];
	onUpdate?: (partial: AgentToolResult<SubagentDetails>) => void;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	onStatusUpdate?: (result: SingleResult) => void;
	onControlChange?: (control: ChildControl | undefined) => void;
}

function emptyUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function finalOutput(messages: Message[]): string {
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

export async function runChild(options: RunChildOptions): Promise<SingleResult> {
	const { agent, agentName, task } = options;

	const args: string[] = ["--mode", "rpc"];
	if (options.sessionId) args.push("--session-id", options.sessionId);
	else args.push("--no-session");

	const selectedModel = options.inheritedModel === null ? undefined : options.inheritedModel ?? agent?.model;
	if (selectedModel) args.push("--model", selectedModel);
	if (agent?.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const result: SingleResult = {
		agent: agentName,
		agentSource: agent?.source ?? "default",
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: selectedModel,
		step: options.step,
	};

	const emitUpdate = () => {
		options.onStatusUpdate?.(result);
		options.onUpdate?.({
			content: [{ type: "text", text: finalOutput(result.messages) || "(running...)" }],
			details: options.makeDetails([result]),
		});
	};

	try {
		if (agent?.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		let wasAborted = false;
		const signal = options.signal;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd ?? options.defaultCwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...buildChildEnvironment(process.env, options.provider, options.providerEnvNames ?? []),
					PI_SUBAGENT_ACTIVE: "1",
					[SUBAGENT_DEPTH_ENV]: String(getSubagentDepth() + 1),
				},
			});
			trackChild(proc);

			const stdoutDecoder = new StringDecoder("utf8");
			let buffer = "";
			let processClosed = false;
			let agentSettled = false;
			let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
			let abortListener: (() => void) | undefined;
			let requestId = 0;
			const pendingRequests = new Map<string, {
				resolve: () => void;
				reject: (error: Error) => void;
				timer: ReturnType<typeof setTimeout>;
			}>();

			const rejectPendingRequests = (error: Error) => {
				for (const pending of pendingRequests.values()) {
					clearTimeout(pending.timer);
					pending.reject(error);
				}
				pendingRequests.clear();
			};

			const writeRpcLine = (value: object) => {
				if (processClosed || proc.stdin.destroyed || !proc.stdin.writable) {
					throw new Error("Subagent RPC input is no longer writable");
				}
				proc.stdin.write(`${JSON.stringify(value)}\n`);
			};

			const sendRpcCommand = (type: "prompt" | "steer", message: string): Promise<void> => {
				const id = `subagent_${++requestId}`;
				return new Promise((resolveRequest, rejectRequest) => {
					const timer = setTimeout(() => {
						pendingRequests.delete(id);
						rejectRequest(new Error(`Timed out waiting for subagent RPC ${type} response`));
					}, RPC_RESPONSE_TIMEOUT_MS);
					timer.unref?.();
					pendingRequests.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
					try {
						writeRpcLine({ id, type, message });
					} catch (error) {
						clearTimeout(timer);
						pendingRequests.delete(id);
						rejectRequest(error instanceof Error ? error : new Error(String(error)));
					}
				});
			};

			const retireControl = () => options.onControlChange?.(undefined);
			const requestGracefulClose = () => {
				if (proc.stdin.writable && !proc.stdin.destroyed) proc.stdin.end();
				if (!forceKillTimer) {
					forceKillTimer = setTimeout(() => {
						if (!processClosed) proc.kill("SIGTERM");
					}, GRACEFUL_CLOSE_MS);
					forceKillTimer.unref?.();
				}
			};

			const processLine = (rawLine: string) => {
				const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "response" && typeof event.id === "string") {
					const pending = pendingRequests.get(event.id);
					if (pending) {
						clearTimeout(pending.timer);
						pendingRequests.delete(event.id);
						if (event.success) pending.resolve();
						else pending.reject(new Error(typeof event.error === "string" ? event.error : `Subagent RPC ${event.command ?? "command"} failed`));
					}
					return;
				}

				// A headless child cannot answer UI prompts; cancel them so the child never stalls waiting.
				if (event.type === "extension_ui_request") {
					if (["select", "confirm", "input", "editor"].includes(event.method) && typeof event.id === "string") {
						try {
							writeRpcLine({ type: "extension_ui_response", id: event.id, cancelled: true });
						} catch {
						}
					}
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					result.messages.push(msg);

					if (msg.role === "assistant") {
						result.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || 0;
						}
						if (msg.provider) result.provider = boundedMetadata(msg.provider);
						if (msg.model) result.model = boundedMetadata(msg.model);
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) {
							result.errorMessage = sanitizeBounded(msg.errorMessage, RESULT_DIAGNOSTIC_CAP, "Error truncated");
						}
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message as Message);
					emitUpdate();
				}

				if (event.type === "agent_settled") {
					agentSettled = true;
					retireControl();
					requestGracefulClose();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += stdoutDecoder.write(data);
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				result.stderr = appendBounded(
					result.stderr,
					terminalSanitize(redactSensitiveText(data.toString())),
					RESULT_DIAGNOSTIC_CAP,
				);
			});

			proc.stdin.on("error", (error) => {
				if (processClosed) return;
				rejectPendingRequests(error);
			});

			proc.on("close", (code, signalName) => {
				processClosed = true;
				retireControl();
				if (forceKillTimer) clearTimeout(forceKillTimer);
				if (signal && abortListener) signal.removeEventListener("abort", abortListener);
				buffer += stdoutDecoder.end();
				if (buffer.trim()) processLine(buffer);
				rejectPendingRequests(new Error(`Subagent RPC process closed (code=${code}, signal=${signalName ?? "none"})`));
				if (code === null && !agentSettled) {
					result.stderr = appendBounded(
						result.stderr,
						`${result.stderr ? "\n" : ""}Subagent process terminated by ${signalName ?? "an unknown signal"}`,
						RESULT_DIAGNOSTIC_CAP,
					);
					resolve(1);
					return;
				}
				resolve(code ?? 0);
			});

			proc.on("error", (error) => {
				result.stderr = appendBounded(
					result.stderr,
					`${result.stderr ? "\n" : ""}${terminalSanitize(redactSensitiveText(error.message))}`,
					RESULT_DIAGNOSTIC_CAP,
				);
			});

			if (signal) {
				abortListener = () => {
					wasAborted = true;
					retireControl();
					proc.kill("SIGTERM");
					forceKillTimer = setTimeout(() => {
						if (!processClosed) proc.kill("SIGKILL");
					}, GRACEFUL_CLOSE_MS);
					forceKillTimer.unref?.();
				};
				if (signal.aborted) abortListener();
				else signal.addEventListener("abort", abortListener, { once: true });
			}

			if (!wasAborted) {
				void sendRpcCommand("prompt", `Task: ${task}`)
					.then(() => {
						if (processClosed || agentSettled) return;
						options.onControlChange?.({
							steer: async (instruction) => {
								if (processClosed || agentSettled) throw new Error("Subagent is no longer running");
								await sendRpcCommand("steer", instruction);
							},
						});
					})
					.catch((error) => {
						result.stopReason = "error";
						result.errorMessage = sanitizeBounded(
							error instanceof Error ? error.message : String(error),
							RESULT_DIAGNOSTIC_CAP,
							"RPC error truncated",
						);
						requestGracefulClose();
					});
			}
		});

		result.exitCode = exitCode;
		if (wasAborted) {
			result.stopReason = "aborted";
			result.errorMessage = "Subagent was aborted";
		}
		return result;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
			}
	}
}
