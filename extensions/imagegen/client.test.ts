import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	extensionFor,
	readDimensions,
	requestImage,
	sniffMimeType,
	validateSize,
	type ImageRequest,
} from "./client.ts";
import { loadReferenceImages, resolveOutputDir, saveImage } from "./files.ts";

/** 1x1 PNG signature followed by a 33-byte IHDR carrying the given size. */
function pngBytes(width: number, height: number): Buffer {
	const buffer = Buffer.alloc(33);
	buffer.writeUInt8(0x89, 0);
	buffer.write("PNG", 1, "latin1");
	buffer.writeUInt32BE(width, 16);
	buffer.writeUInt32BE(height, 20);
	return buffer;
}

function jpegBytes(width: number, height: number): Buffer {
	const buffer = Buffer.alloc(20);
	buffer.writeUInt16BE(0xffd8, 0);
	buffer.writeUInt16BE(0xffc0, 2);
	buffer.writeUInt16BE(11, 4);
	buffer.writeUInt8(8, 6);
	buffer.writeUInt16BE(height, 7);
	buffer.writeUInt16BE(width, 9);
	return buffer;
}

test("validateSize accepts presets, auto and legal custom sizes", () => {
	for (const size of ["auto", "1024x1024", "1024x1536", "1536x1024", "2048x2048", "3840x1280"]) {
		assert.equal(validateSize(size), undefined, size);
	}
});

test("validateSize rejects malformed or out-of-range sizes", () => {
	assert.match(validateSize("bogus") ?? "", /must be/);
	assert.match(validateSize("1000x1000") ?? "", /multiples of 16/);
	assert.match(validateSize("4096x1024") ?? "", /maximum edge|aspect ratio/);
	assert.match(validateSize("3840x1024") ?? "", /aspect ratio/);
	assert.match(validateSize("512x512") ?? "", /below/);
	assert.match(validateSize("3840x3840") ?? "", /exceeds/);
});

test("sniffMimeType reads magic bytes instead of trusting the request", () => {
	assert.equal(sniffMimeType(pngBytes(8, 8)), "image/png");
	assert.equal(sniffMimeType(jpegBytes(8, 8)), "image/jpeg");
	const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
	assert.equal(sniffMimeType(webp), "image/webp");
	assert.equal(sniffMimeType(Buffer.from("GIF89a")), "image/gif");
	assert.equal(sniffMimeType(Buffer.from("nope")), "application/octet-stream");
	assert.equal(extensionFor("image/jpeg"), "jpg");
	assert.equal(extensionFor("image/webp"), "webp");
});

test("readDimensions parses PNG and JPEG headers", () => {
	assert.deepEqual(readDimensions(pngBytes(1254, 1254)), { width: 1254, height: 1254 });
	assert.deepEqual(readDimensions(jpegBytes(1024, 1536)), { width: 1024, height: 1536 });
	assert.equal(readDimensions(Buffer.from("nope")), undefined);
});

function webpBytes(chunk: string, payload: Buffer): Buffer {
	const buffer = Buffer.alloc(20 + payload.length + (payload.length % 2));
	buffer.write("RIFF", 0);
	buffer.writeUInt32LE(buffer.length - 8, 4);
	buffer.write("WEBP", 8);
	buffer.write(chunk, 12);
	buffer.writeUInt32LE(payload.length, 16);
	payload.copy(buffer, 20);
	return buffer;
}

test("readDimensions handles lossy, lossless and extended WebP headers", () => {
	const width = 1254;
	const height = 1536;
	const lossy = Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a, 0, 0, 0, 0]);
	lossy.writeUInt16LE(width | 0x4000, 6); // Scaling bits are not part of the size.
	lossy.writeUInt16LE(height | 0x8000, 8);
	const lossless = Buffer.from([0x2f, 0, 0, 0, 0]);
	lossless.writeUInt32LE(((height - 1) << 14) | (width - 1) | (1 << 28), 1);
	const extended = Buffer.alloc(10);
	extended.writeUIntLE(width - 1, 4, 3);
	extended.writeUIntLE(height - 1, 7, 3);
	for (const image of [webpBytes("VP8 ", lossy), webpBytes("VP8L", lossless), webpBytes("VP8X", extended)]) {
		assert.deepEqual(readDimensions(image), { width, height });
		assert.equal(readDimensions(image.subarray(0, 24)), undefined);
	}
	assert.equal(readDimensions(webpBytes("VP8X", extended.subarray(0, 8))), undefined);
});

function baseRequest(overrides: Partial<ImageRequest> = {}): ImageRequest {
	return {
		baseUrl: "https://api.example/v1",
		apiKey: "sk-test",
		model: "gpt-image-2.6-flare",
		prompt: "a red fox",
		size: "1024x1024",
		quality: "low",
		timeoutMs: 5_000,
		retryBaseDelayMs: 1,
		...overrides,
	};
}

test("requestImage rejects invalid sizes before sending either request type", async () => {
	const fetchImpl: typeof fetch = async () => assert.fail("invalid size reached fetch");
	const images = [{ data: new Uint8Array(pngBytes(8, 8)), mimeType: "image/png", filename: "ref.png" }];
	await assert.rejects(() => requestImage(baseRequest({ size: "bogus", fetchImpl })), /size must be/);
	await assert.rejects(() => requestImage(baseRequest({ size: "512x512", images, fetchImpl })), /size .* is below/);
});

test("requestImage posts JSON, decodes base64, and reports usage", async () => {
	const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(url),
			body: String(init?.body),
			headers: init?.headers as Record<string, string>,
		});
		return new Response(
			JSON.stringify({
				created: 1,
				data: [{ b64_json: pngBytes(1024, 1024).toString("base64") }],
				usage: { input_tokens: 12, output_tokens: 425, total_tokens: 437 },
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;

	const result = await requestImage(baseRequest({ fetchImpl, size: " 1024x1024 " }));
	assert.equal(calls[0]?.url, "https://api.example/v1/images/generations");
	assert.equal(calls[0]?.headers.authorization, "Bearer sk-test");
	const body = JSON.parse(calls[0]!.body);
	assert.equal(body.model, "gpt-image-2.6-flare");
	assert.equal(Object.hasOwn(body, "response_format"), false);
	assert.equal(body.size, "1024x1024");
	assert.equal(body.quality, "low");
	assert.equal(result.images[0]?.mimeType, "image/png");
	assert.deepEqual(result.usage, { input: 12, output: 425, totalTokens: 437 });
	assert.equal(result.attempts, 1);
});

test("requestImage retries transient failures and reports attempts", async () => {
	let attempt = 0;
	const fetchImpl = (async () => {
		attempt += 1;
		if (attempt < 3) {
			return new Response(JSON.stringify({ error: { message: "Invalid token" } }), {
				status: 401,
				headers: { "x-request-id": "req-1" },
			});
		}
		return new Response(JSON.stringify({ data: [{ b64_json: pngBytes(8, 8).toString("base64") }] }), {
			status: 200,
		});
	}) as typeof fetch;

	const result = await requestImage(baseRequest({ fetchImpl }));
	assert.equal(result.attempts, 3);
});

test("requestImage does not retry client errors", async () => {
	let calls = 0;
	const fetchImpl = (async () => {
		calls += 1;
		return new Response(JSON.stringify({ error: { message: "bad prompt", type: "invalid_request" } }), {
			status: 400,
		});
	}) as typeof fetch;

	await assert.rejects(
		() => requestImage(baseRequest({ fetchImpl })),
		(error: Error) => /HTTP 400: bad prompt · invalid_request/.test(error.message),
	);
	assert.equal(calls, 1);
});

test("requestImage rejects URL-only responses", async () => {
	const fetchImpl = (async () =>
		new Response(JSON.stringify({ data: [{ url: "https://cdn.example/x.png" }] }), {
			status: 200,
		})) as typeof fetch;

	await assert.rejects(() => requestImage(baseRequest({ fetchImpl })), /returned a URL instead of base64/);
});

test("requestImage sends edits as multipart", async () => {
	let isForm = false;
	let fieldNames: string[] = [];
	const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
		isForm = init?.body instanceof FormData;
		const form = init?.body as FormData;
		fieldNames = [...form.keys()];
		return new Response(JSON.stringify({ data: [{ b64_json: pngBytes(8, 8).toString("base64") }] }), {
			status: 200,
		});
	}) as typeof fetch;

	await requestImage(
		baseRequest({
			fetchImpl,
			images: [{ data: new Uint8Array(pngBytes(8, 8)), mimeType: "image/png", filename: "ref.png" }],
			complexity: "low",
			outputFormat: "webp",
		}),
	);
	assert.equal(isForm, true);
	assert.deepEqual(fieldNames.sort(), ["complexity", "image", "model", "output_format", "prompt", "quality", "size"]);
});

test("requestImage honours an abort", async () => {
	const controller = new AbortController();
	controller.abort();
	const fetchImpl = (async () => {
		throw new Error("should not be called");
	}) as typeof fetch;
	await assert.rejects(() => requestImage(baseRequest({ fetchImpl, signal: controller.signal })), /aborted/);
});

function pendingBody(signal: AbortSignal, onRead?: () => void): Response {
	return new Response(new ReadableStream<Uint8Array>({
		pull(controller) {
			signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
			onRead?.();
		},
	}, { highWaterMark: 0 }));
}

test("requestImage reports user cancellation during the body read", async () => {
	const controller = new AbortController();
	const fetchImpl: typeof fetch = async (_url, init) => pendingBody(init!.signal!, () => controller.abort());
	await assert.rejects(() => requestImage(baseRequest({ fetchImpl, signal: controller.signal })), { message: "aborted" });
});

test("requestImage reports a timeout during the body read without retrying", async () => {
	let calls = 0;
	const fetchImpl: typeof fetch = async (_url, init) => {
		calls += 1;
		return pendingBody(init!.signal!);
	};
	// AbortSignal.timeout doesn't keep the event loop alive on its own.
	const keepAlive = setTimeout(() => {}, 1_000);
	try {
		await assert.rejects(() => requestImage(baseRequest({ fetchImpl, timeoutMs: 20 })), /timed out after 20ms/);
		assert.equal(calls, 1);
	} finally {
		clearTimeout(keepAlive);
	}
});

test("requestImage does not replay a generation after a response body read failure", async () => {
	let calls = 0;
	const fetchImpl: typeof fetch = async () => {
		calls += 1;
		return new Response(new ReadableStream({
			start(controller) { controller.error(new Error("connection lost")); },
		}));
	};
	await assert.rejects(() => requestImage(baseRequest({ fetchImpl })), /could not read image response body: connection lost/);
	assert.equal(calls, 1);
});

test("saveImage writes a unique file and loadReferenceImages validates input", async () => {
	const dir = mkdtempSync(join(tmpdir(), "imagegen-files-"));
	try {
		const first = await saveImage(dir, "flare", "image/png", pngBytes(1024, 1024).toString("base64"));
		const second = await saveImage(dir, "flare", "image/png", pngBytes(1024, 1024).toString("base64"));
		assert.notEqual(first.path, second.path);
		assert.match(first.path, /flare-[a-z0-9]+\.png$/);
		assert.equal(first.bytes, 33);

		const loaded = await loadReferenceImages(dir, [first.path]);
		assert.equal(loaded[0]?.mimeType, "image/png");

		await assert.rejects(() => loadReferenceImages(dir, [join(dir, "missing.png")]), /not found/);
		assert.equal(resolveOutputDir(dir, "generated"), join(dir, "generated"));
		const absolute = join(dir, "elsewhere");
		assert.equal(resolveOutputDir(dir, absolute), absolute);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
