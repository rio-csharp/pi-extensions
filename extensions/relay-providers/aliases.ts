import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { isObject, type RelayModelConfig } from "./config.ts";

/**
 * Weakest → strongest. This is the only ordering alias resolution ever uses: the alias map's own
 * key insertion order must never influence which variant a request lands on.
 */
export const ALIAS_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type AliasLevel = (typeof ALIAS_LEVELS)[number];

type AliasMap = NonNullable<RelayModelConfig["modelAliases"]>;

function isAliasLevel(value: string): value is AliasLevel {
	return (ALIAS_LEVELS as readonly string[]).includes(value);
}

/**
 * The configured aliases in strength order. An empty-string alias counts as unconfigured, so a
 * broken entry can never be sent upstream (config validation rejects it already).
 */
function configuredAliases(aliases: AliasMap): [AliasLevel, string][] {
	const configured: [AliasLevel, string][] = [];
	for (const level of ALIAS_LEVELS) {
		const target = aliases[level];
		if (typeof target === "string" && target.trim().length > 0) configured.push([level, target]);
	}
	return configured;
}

/**
 * Resolve the upstream model ID for a request.
 * Models without aliases send their registration ID unchanged.
 * Models with aliases never send the registration ID: it is a synthetic picker ID that the
 * upstream does not know, so an unmapped level falls back to the nearest configured level.
 * Every return value is either the unchanged registered ID or one of that model's own alias
 * values; ids are never synthesized or borrowed from another model.
 *
 * pi never forwards the "off" level to a provider (`agent.js` sends `undefined` instead), so
 * `undefined` and "off" are the same request here: no thinking. Resolution order is
 * exact match → next weaker configured level → next stronger configured level → weakest
 * configured variant.
 */
export function resolveRequestModelId(
	baseId: string,
	aliases: RelayModelConfig["modelAliases"],
	level: string | undefined,
): string {
	if (!aliases) return baseId;
	const configured = configuredAliases(aliases);
	if (configured.length === 0) return baseId;
	const find = (candidate: AliasLevel) => configured.find(([configuredLevel]) => configuredLevel === candidate)?.[1];

	const requested = level ?? "off";
	const requestedIndex = isAliasLevel(requested) ? ALIAS_LEVELS.indexOf(requested) : -1;
	if (requestedIndex !== -1) {
		const exact = find(ALIAS_LEVELS[requestedIndex]);
		if (exact) return exact;
		// Nearest weaker configured level first, then the nearest stronger one.
		for (let index = requestedIndex - 1; index >= 0; index -= 1) {
			const weaker = find(ALIAS_LEVELS[index]);
			if (weaker) return weaker;
		}
		for (let index = requestedIndex + 1; index < ALIAS_LEVELS.length; index += 1) {
			const stronger = find(ALIAS_LEVELS[index]);
			if (stronger) return stronger;
		}
	}
	// Unknown level, or a map whose entries cannot match: the weakest configured variant.
	// `configured` is already in strength order, so this never depends on insertion order.
	return configured[0][1];
}

/**
 * Bedrock Converse names the request's model field `modelId`; every other API this extension
 * accepts builds a `model` field. `api` is the resolved model/provider API, never a guess.
 */
export function aliasPayloadField(api: string | undefined): "model" | "modelId" {
	return api === "bedrock-converse-stream" ? "modelId" : "model";
}

/**
 * Build the payload that actually goes upstream. A chained caller hook runs first (its documented
 * "return undefined to keep the payload unchanged" contract still holds), then the alias is forced
 * on the result so a hook can never erase the rewrite that keeps the synthetic picker ID off the
 * wire.
 */
export async function applyAliasToPayload(
	payload: unknown,
	aliasId: string,
	api: string | undefined,
	chained?: (payload: unknown, model: unknown) => unknown,
	payloadModel?: unknown,
): Promise<unknown> {
	const hooked = chained ? await chained(payload, payloadModel) : undefined;
	// Nothing payload-shaped to rewrite: behave exactly as before (hook value, else the payload).
	if (!isObject(payload)) return hooked !== undefined ? hooked : payload;
	// A hook that returns a non-object cannot carry a model id, so the original payload is kept.
	const base = isObject(hooked) ? hooked : payload;
	return { ...base, [aliasPayloadField(api)]: aliasId };
}

/**
 * provider-composer routes full `stream()` calls into an extension's `streamSimple`, so the
 * thinking level arrives as `reasoning` for simple calls and as `reasoningEffort` for full ones.
 */
export function readThinkingLevel(options: SimpleStreamOptions | undefined): string | undefined {
	const shaped = options as { reasoning?: unknown; reasoningEffort?: unknown } | undefined;
	const level = shaped?.reasoning ?? shaped?.reasoningEffort;
	return typeof level === "string" && level.length > 0 ? level : undefined;
}
