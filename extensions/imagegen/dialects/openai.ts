import type { Dialect, DialectRequest } from "./types.ts";

export const MAX_EDGE = 3840;
export const MIN_PIXELS = 655_360;
export const MAX_PIXELS = 8_294_400;

/** Presets documented by the OpenAI image API. */
export const PRESET_SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;

/** Arguments only this API understands. */
const ARGUMENTS = ["quality", "background", "compression", "moderation", "complexity"] as const;

function fieldValue(value: string | number | undefined): string | undefined {
	if (value === undefined) return undefined;
	return String(value);
}

function buildJsonBody(request: DialectRequest): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: request.model,
		prompt: request.prompt,
	};
	const size = fieldValue(request.size);
	if (size) body.size = size;
	if (request.quality) body.quality = request.quality;
	if (request.background) body.background = request.background;
	if (request.outputFormat) body.output_format = request.outputFormat;
	if (request.outputCompression !== undefined) body.output_compression = request.outputCompression;
	if (request.moderation) body.moderation = request.moderation;
	if (request.complexity) body.complexity = request.complexity;
	return body;
}

/** Edits go up as multipart: the API reads the reference files as file parts, not as base64. */
function buildEditForm(request: DialectRequest): FormData {
	const form = new FormData();
	form.set("model", request.model);
	form.set("prompt", request.prompt);
	const size = fieldValue(request.size);
	if (size) form.set("size", size);
	if (request.quality) form.set("quality", request.quality);
	if (request.background) form.set("background", request.background);
	if (request.outputFormat) form.set("output_format", request.outputFormat);
	if (request.outputCompression !== undefined) form.set("output_compression", String(request.outputCompression));
	if (request.moderation) form.set("moderation", request.moderation);
	if (request.complexity) form.set("complexity", request.complexity);
	for (const image of request.images ?? []) {
		const bytes = new Uint8Array(image.data);
		form.append("image", new Blob([bytes], { type: image.mimeType }), image.filename);
	}
	return form;
}

export const openai: Dialect = {
	id: "openai",
	label: "the OpenAI image API",
	arguments: ARGUMENTS,
	maxReferenceImages: 16,
	hasQuality: true,
	presetSizes: PRESET_SIZES,

	validateSize(size) {
		const value = size.trim();
		if (value === "auto") return undefined;
		if ((PRESET_SIZES as readonly string[]).includes(value)) return undefined;
		const match = /^(\d{2,5})x(\d{2,5})$/.exec(value);
		if (!match) {
			return `size must be "auto", one of ${PRESET_SIZES.join(", ")}, or WIDTHxHEIGHT (got "${value}")`;
		}
		const width = Number(match[1]);
		const height = Number(match[2]);
		if (width % 16 !== 0 || height % 16 !== 0) return `size ${value} must use multiples of 16`;
		if (width > MAX_EDGE || height > MAX_EDGE) return `size ${value} exceeds the ${MAX_EDGE}px maximum edge`;
		const ratio = Math.max(width, height) / Math.min(width, height);
		if (ratio > 3) return `size ${value} exceeds the 3:1 aspect ratio limit`;
		const pixels = width * height;
		if (pixels < MIN_PIXELS) return `size ${value} is below ${MIN_PIXELS} pixels`;
		if (pixels > MAX_PIXELS) return `size ${value} exceeds ${MAX_PIXELS} pixels`;
		return undefined;
	},

	describeSize() {
		const presets = PRESET_SIZES.map((size) => `"${size}"`).join(", ");
		return `OpenAI models: "auto", ${presets}, or WIDTHxHEIGHT (multiples of 16, max edge ${MAX_EDGE}, at most 3:1, 0.65-8.3MP).`;
	},

	describeFeatures() {
		return [
			`OpenAI-style models follow the OpenAI image API: sizes ${PRESET_SIZES.join(", ")}, auto, or a custom WIDTHxHEIGHT (multiples of 16, max edge ${MAX_EDGE}, 3:1 ratio limit, 0.65-8.3 megapixels). The provider may round small requests up, so always read the returned pixel size instead of assuming it.`,
		];
	},

	checkArguments({ background, outputFormat, compression }) {
		if (compression !== undefined && outputFormat === "png") {
			return 'compression requires outputFormat "jpeg" or "webp"';
		}
		if (background === "transparent" && outputFormat === "jpeg") {
			return 'transparent background requires outputFormat "png" or "webp"';
		}
		return undefined;
	},

	build(request) {
		const editing = (request.images?.length ?? 0) > 0;
		return editing
			? { body: buildEditForm(request), multipart: true }
			: { body: buildJsonBody(request), multipart: false };
	},
};
