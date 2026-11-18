import { PRESET_SIZES } from "./config.ts";

export const MAX_EDGE = 3840;
export const MIN_PIXELS = 655_360;
export const MAX_PIXELS = 8_294_400;

export interface ReferenceImage {
	data: Uint8Array;
	mimeType: string;
	filename: string;
}

export interface ImageRequest {
	baseUrl: string;
	apiKey: string;
	model: string;
	prompt: string;
	size?: string;
	quality?: string;
	background?: string;
	outputFormat?: string;
	outputCompression?: number;
	moderation?: string;
	complexity?: string;
	images?: ReferenceImage[];
	timeoutMs: number;
	signal?: AbortSignal;
	/** Test seam. */
	fetchImpl?: typeof fetch;
	/** Test seam: overrides the retry backoff base. */
	retryBaseDelayMs?: number;
}

export interface GeneratedImage {
	/** Base64 image data as returned by the API. */
	data: string;
	mimeType: string;
}

export interface ImageResponse {
	images: GeneratedImage[];
	usage?: { input: number; output: number; totalTokens: number };
	attempts: number;
}

const RETRYABLE_STATUS = new Set([401, 403, 408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1500;

export class ImageRequestError extends Error {
	readonly status?: number;
	readonly retryable: boolean;

	constructor(message: string, status?: number, retryable = false) {
		super(message);
		this.name = "ImageRequestError";
		this.status = status;
		this.retryable = retryable;
	}
}

/** Validate an image `size` value against the documented presets and custom-size limits. */
export function validateSize(size: string): string | undefined {
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
}

/** Identify the real image format from its magic bytes; the API may ignore output_format. */
export function sniffMimeType(bytes: Uint8Array): string {
	if (bytes.length >= 8 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "image/webp";
	}
	if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
	return "application/octet-stream";
}

export function extensionFor(mimeType: string): string {
	if (mimeType === "image/jpeg") return "jpg";
	if (mimeType === "image/webp") return "webp";
	if (mimeType === "image/gif") return "gif";
	return "png";
}

function readWebpDimensions(view: DataView): { width: number; height: number } | undefined {
	if (view.byteLength < 20) return undefined;
	// RFC 9649: VP8X stores the canvas size; VP8 and VP8L store the frame size.
	const chunk = view.getUint32(12);
	const size = view.getUint32(16, true);
	if (size > view.byteLength - 20) return undefined;
	if (chunk === 0x56503858 && size >= 10) { // VP8X
		const read24 = (offset: number) => view.getUint16(offset, true) + (view.getUint8(offset + 2) << 16);
		return { width: read24(24) + 1, height: read24(27) + 1 };
	}
	if (chunk === 0x5650384c && size >= 5 && view.getUint8(20) === 0x2f) { // VP8L
		const packed = view.getUint32(21, true);
		return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
	}
	if (chunk === 0x56503820 && size >= 10 && (view.getUint32(22) & 0xffffff) === 0x9d012a) { // VP8
		const width = view.getUint16(26, true) & 0x3fff;
		const height = view.getUint16(28, true) & 0x3fff;
		if (width && height) return { width, height };
	}
	return undefined;
}

/** Pixel dimensions from a PNG, JPEG, or WebP header, when they can be read. */
export function readDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length >= 24 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		return { width: view.getUint32(16), height: view.getUint32(20) };
	}
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (offset + 9 < bytes.length) {
			if (bytes[offset] !== 0xff) {
				offset += 1;
				continue;
			}
			const marker = bytes[offset + 1]!;
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
			}
			offset += 2 + view.getUint16(offset + 2);
		}
	}
	return sniffMimeType(bytes) === "image/webp" ? readWebpDimensions(view) : undefined;
}

function fieldValue(value: string | number | undefined): string | undefined {
	if (value === undefined) return undefined;
	return String(value);
}

function buildJsonBody(request: ImageRequest): Record<string, unknown> {
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

function buildEditForm(request: ImageRequest): FormData {
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

function requestIdOf(response: Response): string | undefined {
	return (
		response.headers.get("x-request-id") ??
		response.headers.get("request-id") ??
		response.headers.get("x-oneapi-request-id") ??
		undefined
	);
}

function errorMessage(payload: unknown, text: string): string {
	if (payload && typeof payload === "object") {
		const error = (payload as { error?: unknown }).error;
		if (typeof error === "string") return error;
		if (error && typeof error === "object") {
			const { message, type, code } = error as { message?: unknown; type?: unknown; code?: unknown };
			const parts = [message, type, code].filter((part): part is string => typeof part === "string" && part !== "");
			if (parts.length > 0) return parts.join(" · ");
		}
		const message = (payload as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	const trimmed = text.trim();
	if (trimmed !== "") return trimmed.slice(0, 400);
	return "empty response body";
}

interface ParsedResponse {
	images: GeneratedImage[];
	usage?: ImageResponse["usage"];
}

function parsePayload(payload: unknown): ParsedResponse {
	if (!payload || typeof payload !== "object") throw new ImageRequestError("response is not a JSON object");
	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data) || data.length === 0) {
		throw new ImageRequestError("response has no data[] entries");
	}
	const images: GeneratedImage[] = [];
	for (const entry of data) {
		if (!entry || typeof entry !== "object") continue;
		const { b64_json: base64, url } = entry as { b64_json?: unknown; url?: unknown };
		if (typeof base64 === "string" && base64 !== "") {
			const bytes = Buffer.from(base64, "base64");
			if (bytes.length === 0) throw new ImageRequestError("response contains empty image data");
			images.push({ data: base64, mimeType: sniffMimeType(bytes) });
			continue;
		}
		if (typeof url === "string" && url !== "") {
			throw new ImageRequestError("the API returned a URL instead of base64 data; use a provider and model that return b64_json");
		}
	}
	if (images.length === 0) throw new ImageRequestError("response contains no usable image");
	const usageRaw = (payload as { usage?: unknown }).usage;
	let usage: ImageResponse["usage"];
	if (usageRaw && typeof usageRaw === "object") {
		const { input_tokens: input, output_tokens: output, total_tokens: total } = usageRaw as Record<string, unknown>;
		if (typeof input === "number" && typeof output === "number") {
			usage = { input, output, totalTokens: typeof total === "number" ? total : input + output };
		}
	}
	return { images, usage };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new ImageRequestError("aborted", undefined, false));
		};
		if (signal?.aborted) {
			clearTimeout(timer);
			reject(new ImageRequestError("aborted", undefined, false));
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** POST one generation or edit request, retrying transient provider failures. */
export async function requestImage(request: ImageRequest): Promise<ImageResponse> {
	if (request.signal?.aborted) throw new ImageRequestError("aborted");
	if (request.size !== undefined) {
		const size = request.size.trim();
		const problem = validateSize(size);
		if (problem) throw new ImageRequestError(problem);
		request = { ...request, size };
	}

	const fetchImpl = request.fetchImpl ?? fetch;
	const retryBaseDelay = request.retryBaseDelayMs ?? BASE_DELAY_MS;
	const editing = (request.images?.length ?? 0) > 0;
	const endpoint = `${request.baseUrl.replace(/\/+$/, "")}/${editing ? "images/edits" : "images/generations"}`;
	let lastError: ImageRequestError | undefined;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		if (request.signal?.aborted) throw new ImageRequestError("aborted");
		const timeout = AbortSignal.timeout(request.timeoutMs);
		const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
		const checkAbort = () => {
			if (request.signal?.aborted) throw new ImageRequestError("aborted");
			if (timeout.aborted) {
				const duration = request.timeoutMs >= 1000 ? `${request.timeoutMs / 1000}s` : `${request.timeoutMs}ms`;
				throw new ImageRequestError(`image request timed out after ${duration}`);
			}
		};
		let response: Response;
		try {
			response = await fetchImpl(endpoint, {
				method: "POST",
				headers: editing
					? { authorization: `Bearer ${request.apiKey}` }
					: { authorization: `Bearer ${request.apiKey}`, "content-type": "application/json" },
				body: editing ? buildEditForm(request) : JSON.stringify(buildJsonBody(request)),
				signal,
			});
		} catch (error) {
			checkAbort();
			lastError = new ImageRequestError(
				`network error: ${error instanceof Error ? error.message : String(error)}`,
				undefined,
				true,
			);
			if (attempt === MAX_ATTEMPTS) break;
			await delay(retryBaseDelay * 2 ** (attempt - 1), request.signal);
			continue;
		}

		let text: string;
		try {
			text = await response.text();
		} catch (error) {
			checkAbort();
			// The provider may already have generated the image; don't replay a failed download.
			throw new ImageRequestError(
				`could not read image response body: ${error instanceof Error ? error.message : String(error)}`,
				response.status,
			);
		}
		checkAbort();
		let payload: unknown;
		try {
			payload = text === "" ? undefined : JSON.parse(text);
		} catch {
			payload = undefined;
		}

		if (!response.ok) {
			const detail = errorMessage(payload, text);
			const requestId = requestIdOf(response);
			const suffix = requestId ? ` (request id ${requestId})` : "";
			lastError = new ImageRequestError(
				`HTTP ${response.status}: ${detail}${suffix}`,
				response.status,
				RETRYABLE_STATUS.has(response.status),
			);
			if (attempt === MAX_ATTEMPTS || !lastError.retryable) break;
			await delay(retryBaseDelay * 2 ** (attempt - 1), request.signal);
			continue;
		}

		if (payload === undefined) throw new ImageRequestError("response is not valid JSON");
		const parsed = parsePayload(payload);
		return { ...parsed, attempts: attempt };
	}

	throw lastError ?? new ImageRequestError("image request failed");
}
