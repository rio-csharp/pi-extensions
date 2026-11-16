import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { providerEnvNames } from "./process.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ChildThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ChildInvocationOverrides {
	model?: string;
	thinking?: string;
	tools?: readonly string[];
	systemPrompt?: string;
}

export interface ChildInvocation {
	model?: string;
	provider?: string;
	providerEnvNames: string[];
	thinking?: ChildThinkingLevel;
	tools?: string[];
	systemPrompt?: string;
}

type InvocationContext = Pick<ExtensionContext, "model" | "modelRegistry">;

interface ModelRef {
	provider: string;
	id: string;
}

const MODEL_THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/i;
const TOOL_PATTERN = /[*?\[\]]/;
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_LISTED_MODELS = 5;
const MAX_LISTED_TOOLS = 24;
/** The parent decides the child's effort; an omitted level means medium rather than the child's own setting. */
export const DEFAULT_CHILD_THINKING: ChildThinkingLevel = "medium";

export function isThinkingLevel(value: string): value is ChildThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function parseModelOverride(reference: string): { model: string; thinking?: ChildThinkingLevel } {
	const trimmed = reference.trim();
	const match = MODEL_THINKING_SUFFIX.exec(trimmed);
	const level = match?.[1]?.toLowerCase();
	if (!match || !level || !isThinkingLevel(level)) return { model: trimmed };
	const model = trimmed.slice(0, match.index);
	if (!model) return { model: trimmed };
	return { model, thinking: level };
}

export function knownToolCatalog(pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">): string[] {
	return [...new Set([...pi.getActiveTools(), ...pi.getAllTools().map((tool) => tool.name)])];
}

export function contextWindowFor(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	reference: string,
): number | undefined {
	const slashIndex = reference.indexOf("/");
	if (slashIndex <= 0) return undefined;
	return ctx.modelRegistry.find(reference.slice(0, slashIndex), reference.slice(slashIndex + 1))?.contextWindow;
}

function omitModelHint(ctx: InvocationContext): string {
	const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	return parentModel ? `omit "model" to inherit ${parentModel}` : `omit "model" to inherit the parent model`;
}

function sharedPrefixLength(left: string, right: string): number {
	const limit = Math.min(left.length, right.length);
	let index = 0;
	while (index < limit && left[index] === right[index]) index++;
	return index;
}

function candidateModels(modelId: string, providerName: string | undefined, ctx: InvocationContext): string[] {
	const models = ctx.modelRegistry.getAll();
	const scoped = providerName ? models.filter((model) => model.provider === providerName) : models;
	const pool = scoped.length > 0 ? scoped : models;
	const target = modelId.toLowerCase();
	const similar = pool.filter((model) => {
		const id = model.id.toLowerCase();
		return id.includes(target) || target.includes(id) || sharedPrefixLength(id, target) >= 4;
	});
	const listed = (similar.length > 0 ? similar : pool)
		.slice(0, MAX_LISTED_MODELS)
		.map((model) => `${model.provider}/${model.id}`);
	return [...new Set(listed)];
}

function resolveModel(reference: string, ctx: InvocationContext): ModelRef {
	const slashIndex = reference.indexOf("/");
	const providerName = slashIndex > 0 ? reference.slice(0, slashIndex) : undefined;
	const modelId = slashIndex > 0 ? reference.slice(slashIndex + 1) : reference;
	const explicit = providerName ? ctx.modelRegistry.find(providerName, modelId) : undefined;
	// An explicit provider prefix is a constraint, exactly like `--provider`: never resolve the same id on another provider.
	const candidates = providerName ? (explicit ? [explicit] : []) : ctx.modelRegistry.getAll().filter((model) => model.id === modelId);
	if (candidates.length === 0) {
		const where = providerName ? `for provider "${providerName}"` : "in the model registry";
		const examples = candidateModels(modelId, providerName, ctx);
		const listed = examples.length > 0 ? ` Candidates: ${examples.join(", ")}.` : " No models are registered.";
		throw new Error(
			`Model override "${reference}" was not found ${where}; an explicit override that cannot be honored is a hard failure, so the subagent was not started: ${omitModelHint(ctx)}.${listed}`,
		);
	}
	const configured = candidates.find((model) => ctx.modelRegistry.hasConfiguredAuth(model));
	if (!configured) {
		const providers = [...new Set(candidates.map((model) => `"${model.provider}"`))].join(", ");
		throw new Error(
			`Model override "${reference}" cannot be used: no configured credentials for provider ${providers}; an explicit override that cannot be honored is a hard failure, so the subagent was not started: ${omitModelHint(ctx)}.`,
		);
	}
	return { provider: configured.provider, id: configured.id };
}

function readThinking(value: string | undefined): ChildThinkingLevel | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return undefined;
	if (isThinkingLevel(normalized)) return normalized;
	throw new Error(
		`Invalid thinking level "${normalized}"; valid values: ${THINKING_LEVELS.join(", ")}. An explicit override that cannot be honored is a hard failure, so the subagent was not started: omit "thinking" to use ${DEFAULT_CHILD_THINKING}.`,
	);
}

function unknownToolsError(unknown: string[], knownTools: readonly string[]): Error {
	const listed = knownTools.slice(0, MAX_LISTED_TOOLS);
	const available = listed.length > 0
		? `${listed.join(", ")}${knownTools.length > listed.length ? `, ... (${knownTools.length} total)` : ""}`
		: "none";
	return new Error(
		`Unknown tools entries: ${unknown.map((name) => JSON.stringify(name)).join(", ")}; available tools: ${available}. An explicit override that cannot be honored is a hard failure, so the subagent was not started: omit "tools" to inherit the child's complete default tool set.`,
	);
}

function readTools(values: readonly string[] | undefined, knownTools: readonly string[]): string[] | undefined {
	if (!values || values.length === 0) return undefined;
	const entries: string[] = [];
	const invalid: string[] = [];
	for (const value of values) {
		const entry = typeof value === "string" ? value.trim() : "";
		if (!entry || entry.length > MAX_TOOL_NAME_LENGTH || /[,\s]/.test(entry)) invalid.push(String(value));
		else entries.push(entry);
	}
	if (invalid.length > 0) {
		throw new Error(
			`Invalid tools entries: ${invalid.map((value) => JSON.stringify(value)).join(", ")}; each entry must be non-empty, contain no commas or whitespace, and be at most ${MAX_TOOL_NAME_LENGTH} characters, so the subagent was not started.`,
		);
	}

	const prefixed = entries.filter((entry) => entry.startsWith("+") || entry.startsWith("-"));
	if (prefixed.length > 0 && prefixed.length !== entries.length) {
		throw new Error(
			`Invalid tools: tool names cannot be mixed with +name or -name entries; got ${entries.map((entry) => JSON.stringify(entry)).join(", ")}. Pass either plain names or only +name/-name entries.`,
		);
	}
	if (prefixed.length > 0) {
		const patterns = prefixed.filter((entry) => TOOL_PATTERN.test(entry));
		if (patterns.length > 0) {
			throw new Error(
				`Invalid tools entries: ${patterns.map((entry) => JSON.stringify(entry)).join(", ")}; wildcards are only allowed for plain tool names, not for +name or -name entries.`,
			);
		}
		const unknown = prefixed.map((entry) => entry.slice(1)).filter((name) => !knownTools.includes(name));
		if (unknown.length > 0) throw unknownToolsError(unknown, knownTools);
		return entries;
	}

	const unknown = entries.filter((entry) => !TOOL_PATTERN.test(entry) && !knownTools.includes(entry));
	if (unknown.length > 0) throw unknownToolsError(unknown, knownTools);
	return entries;
}

export function resolveChildInvocation(
	ctx: InvocationContext,
	overrides: ChildInvocationOverrides = {},
	knownTools: readonly string[] = [],
): ChildInvocation {
	const thinkingOverride = readThinking(overrides.thinking);

	let model: string | undefined;
	let provider = ctx.model?.provider;
	let suffixThinking: ChildThinkingLevel | undefined;

	if (overrides.model !== undefined) {
		const requested = overrides.model.trim();
		if (!requested) {
			throw new Error(
				`Model override is empty; an explicit override that cannot be honored is a hard failure, so the subagent was not started: ${omitModelHint(ctx)}, or pass a model as provider/id.`,
			);
		}
		const parsed = parseModelOverride(requested);
		suffixThinking = parsed.thinking;
		const resolved = resolveModel(parsed.model, ctx);
		model = `${resolved.provider}/${resolved.id}`;
		provider = resolved.provider;
	}

	return {
		model,
		provider,
		providerEnvNames: providerEnvNames(provider, ctx),
		thinking: thinkingOverride ?? suffixThinking ?? DEFAULT_CHILD_THINKING,
		tools: readTools(overrides.tools, knownTools),
		systemPrompt: overrides.systemPrompt?.trim() || undefined,
	};
}
