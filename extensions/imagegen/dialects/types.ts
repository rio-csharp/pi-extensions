import type { ImageApi } from "../config.ts";

/** A local file handed to the provider as edit input. */
export interface ReferenceImage {
	data: Uint8Array;
	mimeType: string;
	filename: string;
}

/** Arguments every dialect accepts; anything else must be listed by the dialect itself. */
export const COMMON_ARGUMENTS = ["prompt", "model", "size", "outputFormat", "images", "outputDir"] as const;

/** One call, in the union of every shape the extension can send; a dialect reads only its own fields. */
export interface DialectRequest {
	model: string;
	prompt: string;
	size?: string;
	quality?: string;
	background?: string;
	outputFormat?: string;
	outputCompression?: number;
	moderation?: string;
	complexity?: string;
	watermark?: boolean;
	promptExtend?: boolean;
	selfCorrection?: boolean;
	images?: ReferenceImage[];
}

/** Request payload for one call: a FormData for multipart APIs, otherwise a JSON object. */
export interface DialectPayload {
	body: FormData | Record<string, unknown>;
	multipart: boolean;
}

/** Argument values that only make sense together; checked before anything is uploaded. */
export interface DialectArgumentCheck {
	background?: string;
	outputFormat: string;
	compression?: number;
}

/** One image API shape. Everything an API decides on its own lives next to that API, not in the tools. */
export interface Dialect {
	readonly id: ImageApi;
	/** Named in error messages, for example "the OpenAI image API". */
	readonly label: string;
	/** Arguments this API understands; the other dialect's arguments fail fast. */
	readonly arguments: readonly string[];
	readonly maxReferenceImages: number;
	/** Whether `quality` is a real knob, so result headers can omit it where it is not. */
	readonly hasQuality: boolean;
	readonly presetSizes: readonly string[];
	/** Error text for an unusable `size`, or undefined when it is valid. */
	validateSize(size: string): string | undefined;
	/** The `size` sentence for the tool schema. */
	describeSize(): string;
	/** Sentences appended to the tool description. */
	describeFeatures(): string[];
	/** Pairwise argument checks this API needs; returns the error text. */
	checkArguments?(input: DialectArgumentCheck): string | undefined;
	build(request: DialectRequest): DialectPayload;
}
