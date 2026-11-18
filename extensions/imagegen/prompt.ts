import type { ImageGenConfig } from "./config.ts";

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
	const lines = [
		"Queue a new image or edit with a text prompt. This returns a job ID immediately; the image is generated and saved in the background.",
		`Pick the model with the "model" argument (${aliases}); the default is "${config.defaultModel}".`,
		buildModelMenu(config),
		"Output sizes follow the OpenAI image API: 1024x1024, 1024x1536, 1536x1024, auto, or a custom WIDTHxHEIGHT (multiples of 16, max edge 3840, 3:1 ratio limit, 0.65-8.3 megapixels). The provider may round small requests up, so always read the returned pixel size instead of assuming it.",
		`Saved files default to "${config.outputDir}" under the working directory. Use imagegen_result to retrieve the finished image and absolute path when needed.`,
		'Quality defaults to "medium" because the provider default (high) costs about nine times more per image at 1K.',
		"Pass images[] to edit existing files instead of generating from scratch.",
	];
	const hasCheapAndDetailed = /flare/.test(aliases) && /sunburst/.test(aliases);
	if (hasCheapAndDetailed) {
		lines.splice(
			3,
			0,
			"Both entries share the same per-image price, so prefer flare unless the request needs exact element placement, dense text, or edits that must leave the rest untouched.",
		);
	}
	return lines.join("\n");
}

/** First line of the tool result: what ran, how long it took, and what it cost. */
export function formatResultHeader(input: {
	modelId: string;
	quality: string;
	requestedSize: string;
	dimensions?: { width: number; height: number };
	elapsedMs: number;
	costUsd: number;
}): string {
	const delivered = input.dimensions ? ` · got ${input.dimensions.width}x${input.dimensions.height}` : "";
	const seconds = (input.elapsedMs / 1000).toFixed(1);
	return `${input.modelId} · ${input.quality} · requested ${input.requestedSize}${delivered} · ${seconds}s · $${input.costUsd.toFixed(2)}`;
}
