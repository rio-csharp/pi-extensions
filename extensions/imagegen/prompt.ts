import { IMAGE_APIS, modelApi, type ImageApi, type ImageGenConfig } from "./config.ts";
import { dialectOf } from "./client.ts";

/** Size guidance for the `size` argument, built from the same dialect rules the validator uses. */
export function buildSizeArgumentDescription(config?: ImageGenConfig): string {
	const apis = config
		? new Set(Object.keys(config.models).map((alias) => modelApi(config, alias)))
		: new Set<ImageApi>(IMAGE_APIS);
	const sentences = [...apis].map((api) => dialectOf(api).describeSize());
	return ["Output size.", ...sentences, "Defaults to the configured size."].join(" ");
}

/** The `<tools>` line shown to the model; keeps the alias list short. */
export function buildModelMenu(config: ImageGenConfig): string {
	return Object.entries(config.models)
		.map(([alias, model]) => `- "${alias}" (${model.id}): ${model.description}`)
		.join("\n");
}

/** Inline list used in the `model` argument description. */
export function buildModelArgumentDescription(config: ImageGenConfig): string {
	const menu = Object.entries(config.models)
		.map(([alias, model]) => `"${alias}" = ${model.description}`)
		.join(" ");
	return `Model to use. ${menu} Defaults to "${config.defaultModel}".`;
}

/**
 * Tool description. Model descriptions from the config land here verbatim, so an
 * edited `description` in imagegen.json is what the model reads when it picks a model.
 */
export function buildDescription(config: ImageGenConfig): string {
	const aliases = Object.keys(config.models).join(", ");
	const apis = [...new Set(Object.keys(config.models).map((alias) => modelApi(config, alias)))];
	const lines = [
		"Queue a new image or edit with a text prompt. This returns a job ID immediately; the image is generated and saved in the background.",
		`Pick the model with the "model" argument (${aliases}); the default is "${config.defaultModel}".`,
		buildModelMenu(config),
	];
	for (const api of apis) lines.push(...dialectOf(api).describeFeatures());
	lines.push(
		`Saved files default to "${config.outputDir}" under the working directory. Use imagegen_result to retrieve the finished image and absolute path when needed.`,
	);
	if (apis.includes("openai")) {
		lines.push('Quality defaults to "medium" because the provider default (high) costs about nine times more per image at 1K.');
	}
	lines.push("Pass images[] to edit existing files instead of generating from scratch.");
	const defaultAlias = config.defaultModel;
	const defaultEntry = config.models[defaultAlias];
	if (
		defaultEntry &&
		modelApi(config, defaultAlias) === "sensenova" &&
		(defaultEntry.pricePerImage ?? config.pricePerImage) === 0
	) {
		lines.push(
			`"${defaultAlias}" is the default and costs nothing under the current plan, so it is the first choice; use the OpenAI entries only when the request needs quality, background/transparency, compression, moderation or complexity.`,
		);
	}
	const hasCheapAndDetailed = /flare/.test(aliases) && /sunburst/.test(aliases) && modelApi(config, defaultAlias) === "openai";
	if (hasCheapAndDetailed) {
		lines.push(
			"Both OpenAI entries share the same per-image price, so prefer flare unless the request needs exact element placement, dense text, or edits that must leave the rest untouched.",
		);
	}
	return lines.join("\n");
}

/** First line of the tool result: what ran, how long it took, and what it cost. */
export function formatResultHeader(input: {
	modelId: string;
	quality?: string;
	requestedSize: string;
	dimensions?: { width: number; height: number };
	elapsedMs: number;
	costUsd: number;
}): string {
	const delivered = input.dimensions ? ` · got ${input.dimensions.width}x${input.dimensions.height}` : "";
	const quality = input.quality ? ` · ${input.quality}` : "";
	const seconds = (input.elapsedMs / 1000).toFixed(1);
	return `${input.modelId}${quality} · requested ${input.requestedSize}${delivered} · ${seconds}s · $${input.costUsd.toFixed(2)}`;
}
