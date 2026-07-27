import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	createCompactRenderer,
	type CompactRenderer,
	type CompactRenderState,
} from "./compact-tool-renderer.ts";

const TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
type ToolName = (typeof TOOL_NAMES)[number];
type AnyDefinition = ToolDefinition<any, any, CompactRenderState>;

interface ToolSettings {
	shellPath?: string;
	shellCommandPrefix?: string;
	images?: {
		autoResize?: boolean;
	};
}

function readJson(path: string): Record<string, any> {
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object" ? value : {};
	} catch {
		return {};
	}
}

function mergeSettings(base: Record<string, any>, override: Record<string, any>): ToolSettings {
	return {
		...base,
		...override,
		images: {
			...(base.images ?? {}),
			...(override.images ?? {}),
		},
	};
}

function expandHome(path: string | undefined): string | undefined {
	if (!path) return path;
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

function loadToolSettings(cwd: string, includeProject: boolean): ToolSettings {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const globalSettings = readJson(join(agentDir, "settings.json"));
	const projectSettings = includeProject ? readJson(join(cwd, CONFIG_DIR_NAME, "settings.json")) : {};
	const settings = mergeSettings(globalSettings, projectSettings);
	settings.shellPath = expandHome(settings.shellPath);
	return settings;
}

function createDefinition(name: ToolName, cwd: string, settings: ToolSettings): AnyDefinition {
	switch (name) {
		case "read":
			return createReadToolDefinition(cwd, {
				autoResizeImages: settings.images?.autoResize ?? true,
			}) as AnyDefinition;
		case "bash":
			return createBashToolDefinition(cwd, {
				shellPath: settings.shellPath,
				commandPrefix: settings.shellCommandPrefix,
			}) as AnyDefinition;
		case "edit":
			return createEditToolDefinition(cwd) as AnyDefinition;
		case "write":
			return createWriteToolDefinition(cwd) as AnyDefinition;
		case "grep":
			return createGrepToolDefinition(cwd) as AnyDefinition;
		case "find":
			return createFindToolDefinition(cwd) as AnyDefinition;
		case "ls":
			return createLsToolDefinition(cwd) as AnyDefinition;
	}
}

function displayPath(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) return "...";
	const home = homedir();
	return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

function quote(value: unknown): string {
	return JSON.stringify(value ?? "");
}

function formatInvocation(name: ToolName, args: Record<string, any>, theme: Theme): string {
	switch (name) {
		case "bash":
			// Deliberately preserve the complete command and its original newlines.
			return typeof args.command === "string" && args.command.length > 0 ? args.command : "...";

		case "read": {
			let text = displayPath(args.path ?? args.file_path);
			if (args.offset !== undefined || args.limit !== undefined) {
				const start = args.offset ?? 1;
				const end = args.limit !== undefined ? start + args.limit - 1 : "";
				text += `:${start}${end === "" ? "" : `-${end}`}`;
			}
			return text;
		}

		case "write": {
			const path = displayPath(args.path ?? args.file_path);
			if (typeof args.content !== "string") return path;
			const lines = args.content.length === 0 ? 0 : args.content.split("\n").length;
			return `${path}${theme.fg("dim", ` · ${lines} lines`)}`;
		}

		case "edit": {
			const path = displayPath(args.path ?? args.file_path);
			const count = Array.isArray(args.edits) ? args.edits.length : 0;
			return `${path}${count > 0 ? theme.fg("dim", ` · ${count} replacement${count === 1 ? "" : "s"}`) : ""}`;
		}

		case "grep": {
			const options: string[] = [];
			if (args.path !== undefined) options.push(`path=${quote(args.path)}`);
			if (args.glob !== undefined) options.push(`glob=${quote(args.glob)}`);
			if (args.ignoreCase !== undefined) options.push(`ignoreCase=${args.ignoreCase}`);
			if (args.literal !== undefined) options.push(`literal=${args.literal}`);
			if (args.context !== undefined) options.push(`context=${args.context}`);
			if (args.limit !== undefined) options.push(`limit=${args.limit}`);
			return `${quote(args.pattern)}${options.length ? ` · ${options.join(" ")}` : ""}`;
		}

		case "find": {
			const options: string[] = [];
			if (args.path !== undefined) options.push(`path=${quote(args.path)}`);
			if (args.limit !== undefined) options.push(`limit=${args.limit}`);
			return `${quote(args.pattern)}${options.length ? ` · ${options.join(" ")}` : ""}`;
		}

		case "ls": {
			let text = displayPath(args.path ?? ".");
			if (args.limit !== undefined) text += ` · limit=${args.limit}`;
			return text;
		}
	}
}

function getTextResult(result: any): string {
	const block = result?.content?.find((item: any) => item?.type === "text");
	return typeof block?.text === "string" ? block.text : "";
}

function countOutputLines(text: string): number {
	if (!text) return 0;
	return text.replace(/\r\n/g, "\n").split("\n").length;
}

export function registerCompactBuiltInTools(pi: ExtensionAPI): void {
	const renderers: CompactRenderer[] = [];
	const initialSettings = loadToolSettings(process.cwd(), false);

	for (const name of TOOL_NAMES) {
		const original = createDefinition(name, process.cwd(), initialSettings);
		const renderer = createCompactRenderer(
			name,
			(args, theme) => formatInvocation(name, args, theme),
			name === "bash"
				? {
						observeResult(result, options, state) {
							if (options.isPartial) state.outputLines = countOutputLines(getTextResult(result));
						},
					}
				: undefined,
		);
		renderers.push(renderer);

		pi.registerTool({
			name,
			label: original.label,
			description: original.description,
			promptSnippet: original.promptSnippet,
			promptGuidelines: original.promptGuidelines,
			parameters: original.parameters,
			constrainedSampling: original.constrainedSampling,
			prepareArguments: original.prepareArguments,
			executionMode: original.executionMode,
			renderShell: renderer.renderShell,
			renderCall: renderer.renderCall,
			renderResult: renderer.renderResult,

			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const settings = loadToolSettings(ctx.cwd, ctx.isProjectTrusted());
				const runtimeDefinition = createDefinition(name, ctx.cwd, settings);
				return runtimeDefinition.execute(toolCallId, params, signal, onUpdate, ctx);
			},
		} as AnyDefinition);
	}

	pi.on("session_shutdown", () => {
		for (const renderer of renderers) renderer.dispose();
	});
}
