import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { extensionFor, sniffMimeType, type ReferenceImage } from "./client.ts";

export const MAX_REFERENCE_BYTES = 32 * 1024 * 1024;

function timestamp(date = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return [
		date.getFullYear(),
		pad(date.getMonth() + 1),
		pad(date.getDate()),
		"-",
		pad(date.getHours()),
		pad(date.getMinutes()),
		pad(date.getSeconds()),
	].join("");
}

function safeSegment(value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
	return cleaned === "" ? "image" : cleaned.slice(0, 40);
}

export function resolveOutputDir(cwd: string, outputDir: string): string {
	const trimmed = outputDir.trim();
	if (trimmed === "") return resolve(cwd, "generated");
	if (isAbsolute(trimmed)) return resolve(trimmed);
	if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
		return resolve(process.env.HOME ?? process.env.USERPROFILE ?? cwd, trimmed.slice(2));
	}
	return resolve(cwd, trimmed);
}

export interface SavedImage {
	path: string;
	relativePath: string;
	bytes: number;
}

/** Write one generated image under `dir`, never overwriting an existing file. */
export async function saveImage(
	dir: string,
	alias: string,
	mimeType: string,
	base64: string,
): Promise<SavedImage> {
	const buffer = Buffer.from(base64, "base64");
	const bytes = buffer.byteLength;
	const extension = extensionFor(mimeType);
	await mkdir(dir, { recursive: true });
	const stem = `${timestamp()}-${safeSegment(alias)}-${Math.random().toString(36).slice(2, 8)}`;
	const path = join(dir, `${stem}.${extension}`);
	return withFileMutationQueue(path, async () => {
		await writeFile(path, buffer, { flag: "wx" });
		return { path, relativePath: path, bytes };
	});
}

export class ReferenceError extends Error {}

/** Read reference images from disk for an edit request. */
export async function loadReferenceImages(cwd: string, paths: string[]): Promise<ReferenceImage[]> {
	const images: ReferenceImage[] = [];
	for (const raw of paths) {
		const cleaned = raw.trim().replace(/^@/, "");
		if (cleaned === "") throw new ReferenceError("reference image path is empty");
		const absolute = isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
		let info;
		try {
			info = await stat(absolute);
		} catch {
			throw new ReferenceError(`reference image not found: ${cleaned}`);
		}
		if (!info.isFile()) throw new ReferenceError(`reference image is not a file: ${cleaned}`);
		if (info.size > MAX_REFERENCE_BYTES) {
			throw new ReferenceError(`reference image is larger than 32MB: ${cleaned}`);
		}
		const data = await readFile(absolute);
		const mimeType = sniffMimeType(data);
		if (!mimeType.startsWith("image/")) {
			throw new ReferenceError(`reference file is not a PNG, JPEG, WebP, or GIF image: ${cleaned}`);
		}
		images.push({
			data: new Uint8Array(data),
			mimeType,
			filename: basename(absolute).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "reference.png",
		});
	}
	return images;
}
