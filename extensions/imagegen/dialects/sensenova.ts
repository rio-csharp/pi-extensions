import type { Dialect, DialectRequest } from "./types.ts";

/** Recommended 2K/4K sizes documented by the SenseNova image API. */
export const SENSENOVA_PRESET_SIZES = [
	"2048x2048",
	"2720x1536",
	"1536x2720",
	"1664x2496",
	"2496x1664",
	"4096x4096",
] as const;
export const SENSENOVA_SIZE_STEP = 32;
export const SENSENOVA_MIN_EDGE = 512;
export const SENSENOVA_MAX_EDGE = 4096;
export const SENSENOVA_MAX_REFERENCE_IMAGES = 5;

/** Arguments only this API understands. */
const ARGUMENTS = ["watermark", "promptExtend", "selfCorrection"] as const;

function fieldValue(value: string | number | undefined): string | undefined {
	if (value === undefined) return undefined;
	return String(value);
}

/** Edits are JSON too: the references travel inline as data URLs, never as multipart parts. */
function buildJsonBody(request: DialectRequest): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: request.model,
		prompt: request.prompt,
		n: 1,
		// Ask for inline bytes: signed URLs expire after 24 hours and cost an extra download.
		response_format: "b64_json",
	};
	const size = fieldValue(request.size);
	if (size) body.size = size;
	if (request.outputFormat) body.output_format = request.outputFormat;
	// Default the logo off: the provider default is on, and a watermark is rarely what a user asked for.
	body.watermark = request.watermark ?? false;
	if (request.promptExtend !== undefined) body.prompt_extend = request.promptExtend;
	if (request.selfCorrection !== undefined) body.self_correction = request.selfCorrection;
	if (request.images && request.images.length > 0) {
		body.images = request.images.map((image) => ({
			image_url: `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`,
		}));
	}
	return body;
}

export const sensenova: Dialect = {
	id: "sensenova",
	label: "the SenseNova image API",
	arguments: ARGUMENTS,
	maxReferenceImages: SENSENOVA_MAX_REFERENCE_IMAGES,
	hasQuality: false,
	presetSizes: SENSENOVA_PRESET_SIZES,

	validateSize(size) {
		const value = size.trim();
		if (value === "auto") return undefined;
		if ((SENSENOVA_PRESET_SIZES as readonly string[]).includes(value)) return undefined;
		const match = /^(\d{3,4})x(\d{3,4})$/.exec(value);
		if (!match) {
			return `size must be "auto", one of ${SENSENOVA_PRESET_SIZES.join(", ")}, or WIDTHxHEIGHT (got "${value}")`;
		}
		const width = Number(match[1]);
		const height = Number(match[2]);
		if (width % SENSENOVA_SIZE_STEP !== 0 || height % SENSENOVA_SIZE_STEP !== 0) {
			return `size ${value} must use multiples of ${SENSENOVA_SIZE_STEP}`;
		}
		if (width < SENSENOVA_MIN_EDGE || height < SENSENOVA_MIN_EDGE) {
			return `size ${value} must be at least ${SENSENOVA_MIN_EDGE}px on each side`;
		}
		if (width > SENSENOVA_MAX_EDGE || height > SENSENOVA_MAX_EDGE) {
			return `size ${value} exceeds the ${SENSENOVA_MAX_EDGE}px maximum edge`;
		}
		const ratio = Math.max(width, height) / Math.min(width, height);
		if (ratio > 3) return `size ${value} exceeds the 3:1 aspect ratio limit`;
		return undefined;
	},

	describeSize() {
		const presets = SENSENOVA_PRESET_SIZES.map((size) => `"${size}"`).join(", ");
		return `SenseNova models: "auto" or WIDTHxHEIGHT with multiples of ${SENSENOVA_SIZE_STEP}, ${SENSENOVA_MIN_EDGE}-${SENSENOVA_MAX_EDGE} per side, at most 3:1; recommended ${presets} (4096x4096 is 4K).`;
	},

	describeFeatures() {
		return [
			`SenseNova models use /v1/images/generations and /v1/images/edits (sensenova-u1.x). Sizes: "auto" or WIDTHxHEIGHT with multiples of ${SENSENOVA_SIZE_STEP}, ${SENSENOVA_MIN_EDGE}-${SENSENOVA_MAX_EDGE} per side and at most 3:1; the recommended set is ${SENSENOVA_PRESET_SIZES.join(", ")} (4096x4096 is 4K). They add watermark (off unless you pass watermark true), promptExtend (provider default true) and selfCorrection (provider default true); they accept up to ${SENSENOVA_MAX_REFERENCE_IMAGES} reference images and ignore quality, background, compression, moderation and complexity.`,
		];
	},

	build(request) {
		return { body: buildJsonBody(request), multipart: false };
	},
};
