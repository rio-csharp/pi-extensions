import type { ImageApi } from "./config.ts";
import { openai } from "./dialects/openai.ts";
import { sensenova } from "./dialects/sensenova.ts";
import type { Dialect, DialectRequest, ReferenceImage } from "./dialects/types.ts";

export type { ReferenceImage } from "./dialects/types.ts";

/** Every dialect this extension can speak, keyed by the `api` value used in imagegen.json. */
export const DIALECTS: Record<ImageApi, Dialect> = { openai, sensenova };

/** Arguments that belong to exactly one dialect; the rest are shared by all of them. */
export const DIALECT_ARGUMENTS = Object.values(DIALECTS).flatMap((dialect) => dialect.arguments);

/** Largest reference count any configured dialect accepts, for the tool schema. */
export const MAX_REFERENCE_IMAGES = Math.max(...Object.values(DIALECTS).map((dialect) => dialect.maxReferenceImages));

/** Look up one dialect; unknown values fall back to the OpenAI shape. */
export function dialectOf(api: ImageApi | undefined): Dialect {
	return (api && DIALECTS[api]) || openai;
}

export interface ImageRequest extends DialectRequest {
	baseUrl: string;
	apiKey: string;
	/** Request shape; defaults to "openai". */
	api?: ImageApi;
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

/** Validate an image `size` value against the rules of the selected image API. */
export function validateSize(size: string, api: ImageApi = "openai"): string | undefined {
	return dialectOf(api).validateSize(size);
}

/** Identify the real image format from its magic bytes; the API may ignore output_format. */
export function sniffMimeType(bytes: Uint8Array): string {
	if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)) {
		return "image/png";
	}
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
	if (
		bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
		(bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
	) return "image/gif";
	return "application/octet-stream";
}

export function extensionFor(mimeType: string): string {
	if (mimeType === "image/png") return "png";
	if (mimeType === "image/jpeg") return "jpg";
	if (mimeType === "image/webp") return "webp";
	if (mimeType === "image/gif") return "gif";
	throw new ImageRequestError("unsupported image format");
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
	if (bytes.length >= 24 && sniffMimeType(bytes) === "image/png") {
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
			const mimeType = sniffMimeType(bytes);
			if (mimeType === "application/octet-stream") {
				throw new ImageRequestError("response contains unsupported image data; expected PNG, JPEG, WebP, or GIF");
			}
			images.push({ data: base64, mimeType });
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
	const dialect = dialectOf(request.api);
	if (request.size !== undefined) {
		const size = request.size.trim();
		const problem = dialect.validateSize(size);
		if (problem) throw new ImageRequestError(problem);
		request = { ...request, size };
	}
	if ((request.images?.length ?? 0) > dialect.maxReferenceImages) {
		throw new ImageRequestError(
			`${dialect.label} accepts at most ${dialect.maxReferenceImages} reference images`,
		);
	}

	const fetchImpl = request.fetchImpl ?? fetch;
	const retryBaseDelay = request.retryBaseDelayMs ?? BASE_DELAY_MS;
	const editing = (request.images?.length ?? 0) > 0;
	const payload = dialect.build(request);
	let endpoint: URL;
	try {
		endpoint = new URL(request.baseUrl);
	} catch {
		throw new ImageRequestError("invalid image API base URL");
	}
	if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
		throw new ImageRequestError("image API base URL must be HTTP(S)");
	}
	if (endpoint.username || endpoint.password) {
		throw new ImageRequestError("image API base URL must not embed credentials");
	}
	endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/images/${editing ? "edits" : "generations"}`;
	endpoint.hash = ""; // Preserve configured query parameters. Fragments are client-side only.
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
				headers: payload.multipart
					? { authorization: `Bearer ${request.apiKey}` }
					: { authorization: `Bearer ${request.apiKey}`, "content-type": "application/json" },
				body: payload.multipart ? payload.body as FormData : JSON.stringify(payload.body),
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
		let parsedBody: unknown;
		try {
			parsedBody = text === "" ? undefined : JSON.parse(text);
		} catch {
			parsedBody = undefined;
		}

		if (!response.ok) {
			const detail = errorMessage(parsedBody, text);
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

		if (parsedBody === undefined) throw new ImageRequestError("response is not valid JSON");
		const parsed = parsePayload(parsedBody);
		return { ...parsed, attempts: attempt };
	}

	throw lastError ?? new ImageRequestError("image request failed");
}
