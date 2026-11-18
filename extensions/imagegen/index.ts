import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ImageContent, TextContent, Usage } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readDimensions, requestImage, validateSize, type GeneratedImage, type ImageRequest } from "./client.ts";
import {
	BACKGROUNDS,
	COMPLEXITIES,
	OUTPUT_FORMATS,
	QUALITIES,
	MODERATIONS,
	configProblem,
	imageCostUsd,
	loadImageGenConfig,
	type Background,
	type Complexity,
	type Moderation,
	type OutputFormat,
	type Quality,
} from "./config.ts";
import { loadReferenceImages, resolveOutputDir, saveImage, type SavedImage } from "./files.ts";
import { ImageJobs } from "./jobs.ts";
import { buildDescription, buildModelArgumentDescription, formatResultHeader } from "./prompt.ts";

const MAX_PROMPT_CHARS = 32_000;
const MAX_REFERENCE_IMAGES = 16;

interface ToolDetails {
	phase: "queued" | "running" | "done" | "failed";
	jobId: string;
	model?: string;
	quality?: string;
	requestedSize?: string;
	width?: number;
	height?: number;
	format?: string;
	bytes?: number;
	file?: string;
	elapsedMs?: number;
	attempts?: number;
	costUsd?: number;
}

interface GenerateParams {
	prompt: string;
	model?: string;
	size?: string;
	quality?: Quality;
	background?: Background;
	outputFormat?: OutputFormat;
	compression?: number;
	moderation?: Moderation;
	complexity?: Complexity;
	images?: string[];
	outputDir?: string;
}

function notifyConfigWarning(ctx: ExtensionContext | undefined, warning: string): void {
	if (!ctx?.hasUI) return;
	ctx.ui.notify(warning, "warning");
}

function imageTextLine(image: GeneratedImage, path: string, index: number, total: number): string {
	const bytes = Buffer.from(image.data, "base64");
	const dimensions = readDimensions(bytes);
	const size = dimensions ? `${dimensions.width}x${dimensions.height}` : "unknown size";
	const prefix = total > 1 ? `${index + 1}/${total}. ` : "";
	return `${prefix}${path} · ${size} · ${(bytes.byteLength / 1024).toFixed(0)}KB`;
}

interface CompletedImageJob {
	content: (TextContent | ImageContent)[];
	paths: string[];
	details: Omit<ToolDetails, "phase" | "jobId">;
	usage: Usage;
}

async function generate(
	request: ImageRequest & { size: string; quality: string },
	cwd: string,
	referencePaths: string[],
	dir: string,
	alias: string,
	pricePerImage: number,
	signal: AbortSignal,
): Promise<CompletedImageJob> {
	const images = referencePaths.length > 0 ? await loadReferenceImages(cwd, referencePaths) : undefined;
	const startedAt = Date.now();
	const result = await requestImage({ ...request, images, signal });
	const saved: SavedImage[] = [];
	for (const image of result.images) {
		signal.throwIfAborted();
		saved.push(await saveImage(dir, alias, image.mimeType, image.data));
	}

	const elapsedMs = Date.now() - startedAt;
	const first = result.images[0]!;
	const dimensions = readDimensions(Buffer.from(first.data, "base64"));
	const costUsd = imageCostUsd(pricePerImage, result.images.length);
	const header = formatResultHeader({
		modelId: request.model,
		quality: request.quality,
		requestedSize: request.size,
		dimensions,
		elapsedMs,
		costUsd,
	});
	const lines = result.images.map((image, index) => imageTextLine(image, saved[index]!.path, index, saved.length));
	return {
		content: [
			{ type: "text", text: [header, ...lines].join("\n") },
			...result.images.map((image): ImageContent => ({ type: "image", ...image })),
		],
		paths: saved.map((image) => image.path),
		details: {
			model: request.model,
			quality: request.quality,
			requestedSize: request.size,
			width: dimensions?.width,
			height: dimensions?.height,
			format: first.mimeType,
			bytes: saved.reduce((total, image) => total + image.bytes, 0),
			file: saved[0]!.path,
			elapsedMs,
			attempts: result.attempts,
			costUsd,
		},
		usage: {
			input: result.usage?.input ?? 0,
			output: result.usage?.output ?? 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: result.usage?.totalTokens ?? 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd },
		},
	};
}

export default function (pi: ExtensionAPI) {
	const startupConfig = loadImageGenConfig();
	const description = buildDescription(startupConfig);
	const shownWarnings = new Set<string>();
	const jobs = new ImageJobs<CompletedImageJob>();
	pi.on("session_shutdown", () => jobs.close());

	pi.registerTool(defineTool({
		name: "generate_image",
		label: "Generate Image",
		description,
		promptSnippet: "Queue background image generation or editing without waiting",
		promptGuidelines: [
			'Use generate_image when the user asks for a picture, illustration, icon, mockup, or an edit of an existing image; pass model "sunburst" for final assets and edits that must not disturb the rest.',
			"Quote any text that must appear in the image exactly, and state where it belongs.",
			"generate_image returns a job ID, not the finished image. Continue with unrelated work or finish the response; do not poll or claim the image is ready. Use imagegen_result when the result is needed, and use its actual pixel size and path.",
		],
		parameters: Type.Object({
			prompt: Type.String({
				minLength: 1,
				maxLength: MAX_PROMPT_CHARS,
				description:
					"What to draw or how to change the reference images. Describe the subject, style, lighting, composition and any exact text.",
			}),
			model: Type.Optional(
				Type.String({
					description: buildModelArgumentDescription(startupConfig),
				}),
			),
			size: Type.Optional(
				Type.String({
					description:
						'Output size: "1024x1024", "1024x1536", "1536x1024", "auto", or WIDTHxHEIGHT (multiples of 16, max edge 3840, at most 3:1). Defaults to the configured size.',
				}),
			),
			quality: Type.Optional(
				StringEnum(QUALITIES, {
					description:
						'Rendering effort and price. "low" is cheapest, "medium" is the default, "high" is the provider default and costs several times more; xhigh and max exist on 2.6 only.',
				}),
			),
			background: Type.Optional(
				StringEnum(BACKGROUNDS, {
					description: 'Background handling; "transparent" requires a png or webp output format.',
				}),
			),
			outputFormat: Type.Optional(
				StringEnum(OUTPUT_FORMATS, { description: 'File format, default "png".' }),
			),
			compression: Type.Optional(
				Type.Integer({
					minimum: 0,
					maximum: 100,
					description: "Compression level for jpeg or webp output.",
				}),
			),
			moderation: Type.Optional(
				StringEnum(MODERATIONS, { description: 'Content moderation level; "low" is more permissive.' }),
			),
			complexity: Type.Optional(
				StringEnum(COMPLEXITIES, {
					description:
						"How much the model plans before drawing (gpt-image-2.6 only). Same price at every level; omit to use the provider default.",
				}),
			),
			images: Type.Optional(
				Type.Array(Type.String(), {
					maxItems: MAX_REFERENCE_IMAGES,
					description:
						"Reference image paths (relative to the working directory). Any reference image switches to the edit endpoint: 1-16 images.",
				}),
			),
			outputDir: Type.Optional(
				Type.String({ description: "Directory to save the image in, relative to the working directory." }),
			),
		}),
		executionMode: "sequential",

		renderCall(args, theme: Theme) {
			const alias = typeof args.model === "string" ? args.model : startupConfig.defaultModel;
			const size = typeof args.size === "string" ? args.size : startupConfig.defaultSize;
			const quality = typeof args.quality === "string" ? args.quality : startupConfig.defaultQuality;
			const prompt = typeof args.prompt === "string" ? args.prompt.replace(/\s+/g, " ").trim() : "";
			const shown = prompt.length > 100 ? `${prompt.slice(0, 100)}…` : prompt;
			const references = Array.isArray(args.images) && args.images.length > 0 ? ` · ${args.images.length} ref` : "";
			const head = theme.fg("toolTitle", theme.bold("generate_image"));
			const meta = theme.fg("dim", ` · ${alias} · ${size} · ${quality}${references}`);
			return new Text(`${head}${meta}\n  ${shown}`, 0, 0);
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const input = params as unknown as GenerateParams;
			if (signal?.aborted) throw new Error("generate_image aborted");
			if (!ctx?.hasUI) throw new Error("Background image generation requires an active TUI or RPC session.");
			const config = loadImageGenConfig();
			const problem = configProblem(config);
			if (problem) throw new Error(`generate_image is not configured: ${problem}`);
			for (const warning of config.warnings) {
				if (shownWarnings.has(warning)) continue;
				shownWarnings.add(warning);
				notifyConfigWarning(ctx, warning);
			}

			const alias = input.model?.trim() || config.defaultModel;
			const model = Object.hasOwn(config.models, alias) ? config.models[alias] : undefined;
			if (!model) {
				throw new Error(
					`unknown model "${alias}"; configured models are ${Object.keys(config.models).join(", ")}`,
				);
			}

			const requestedSize = input.size?.trim() || config.defaultSize;
			const sizeProblem = validateSize(requestedSize);
			if (sizeProblem) throw new Error(sizeProblem);
			const quality = input.quality ?? model.quality ?? config.defaultQuality;
			const pricePerImage = model.pricePerImage ?? config.pricePerImage;
			const outputFormat = input.outputFormat ?? "png";
			if (input.compression !== undefined && outputFormat === "png") {
				throw new Error('compression requires outputFormat "jpeg" or "webp"');
			}
			if (input.background === "transparent" && outputFormat === "jpeg") {
				throw new Error('transparent background requires outputFormat "png" or "webp"');
			}

			const referencePaths = input.images ?? [];
			if (referencePaths.length > MAX_REFERENCE_IMAGES) {
				throw new Error(`at most ${MAX_REFERENCE_IMAGES} reference images are supported`);
			}
			const cwd = ctx.cwd;
			const dir = resolveOutputDir(cwd, input.outputDir ?? config.outputDir);
			const request = {
				baseUrl: config.baseUrl,
				apiKey: config.apiKey,
				model: model.id,
				prompt: input.prompt,
				size: requestedSize,
				quality,
				background: input.background,
				outputFormat,
				outputCompression: input.compression,
				moderation: input.moderation,
				complexity: input.complexity,
				timeoutMs: config.timeoutMs,
			};
			const jobId = jobs.enqueue(
				(jobSignal) => generate(request, cwd, referencePaths, dir, alias, pricePerImage, jobSignal),
				(id, state) => {
					if (state.phase === "done") {
						ctx.ui.notify(`Image job ${id} complete:\n${state.result.paths.join("\n")}`, "info");
					} else {
						ctx.ui.notify(`Image job ${id} failed: ${state.error}`, "error");
					}
				},
			);
			return {
				content: [{ type: "text", text: `Queued image job ${jobId}. Generation continues in the background; the user will be notified. Use imagegen_result with this jobId only when you need the result.` }],
				details: { phase: "queued", jobId, model: model.id, quality, requestedSize } satisfies ToolDetails,
			};
		},
	}));

	const resultParams = Type.Object({ jobId: Type.String({ description: "Job ID returned by generate_image." }) });
	pi.registerTool(defineTool<typeof resultParams, ToolDetails>({
		name: "imagegen_result",
		label: "Image Job Result",
		description: "Look up a background generate_image job. Returns its current status immediately, or the image and saved path if complete. Does not wait; do not poll repeatedly.",
		promptSnippet: "Check a background image job or retrieve its finished image",
		parameters: resultParams,
		async execute(_toolCallId, { jobId }, signal) {
			if (signal?.aborted) throw new Error("imagegen_result aborted");
			const state = jobs.get(jobId);
			if (!state) throw new Error(`Unknown image job ${jobId}. Only recent jobs in this session are available.`);
			if (state.phase === "done") {
				const usage = state.usageReported ? undefined : state.result.usage;
				state.usageReported = true;
				return {
					content: state.result.content,
					details: { ...state.result.details, phase: "done", jobId } satisfies ToolDetails,
					usage,
				};
			}
			return {
				content: [{ type: "text", text: state.phase === "failed"
					? `Image job ${jobId} failed: ${state.error}`
					: `Image job ${jobId} is ${state.phase}. Continue without waiting; the user will be notified.` }],
				details: { phase: state.phase, jobId } satisfies ToolDetails,
				isError: state.phase === "failed",
			};
		},
	}));

	pi.registerCommand("imagegen", {
		description: "Show the generate_image configuration",
		handler: async (_args, ctx) => {
			const config = loadImageGenConfig(getAgentDir());
			const problem = configProblem(config);
			const lines = [
				`provider: ${config.provider ?? "(none)"}`,
				`base URL: ${config.baseUrl || "(unset)"}`,
				`api key: ${config.apiKey ? "configured" : "(unset)"}`,
				`default: ${config.defaultModel} · ${config.defaultQuality} · ${config.defaultSize}`,
				`output dir: ${resolveOutputDir(ctx.cwd, config.outputDir)}`,
				`timeout: ${Math.round(config.timeoutMs / 1000)}s`,
				"models:",
				...Object.entries(config.models).map(
					([alias, model]) => `  ${alias} → ${model.id}${model.quality ? ` (quality ${model.quality})` : ""}`,
				),
			];
			if (problem) lines.push(`status: not usable — ${problem}`);
			if (config.warnings.length > 0) lines.push("warnings:", ...config.warnings.map((w) => `  ${w}`));
			ctx.ui.notify(lines.join("\n"), problem ? "warning" : "info");
		},
	});
}
