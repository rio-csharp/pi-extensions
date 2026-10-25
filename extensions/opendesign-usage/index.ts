import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const STATUS_KEY = "opendesign-usage";
const CONFIG_PATH = join(
	process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
	"opendesign-usage.json",
);
const DEFAULT_API_URL = "https://amr-api.open-design.ai";
const DEFAULT_PROVIDERS = ["amr-link"];
const DEFAULT_REFRESH_MS = 5 * 60_000;
const MIN_REFRESH_MS = 30_000;
const AGENT_END_THROTTLE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

interface UsageConfig {
	controlKey: string;
	apiUrl: string;
	providers: Set<string>;
	workspaceId?: string;
	refreshIntervalMs: number;
}

interface WorkspaceCurrent {
	activeWorkspaceId?: unknown;
	workspaceId?: unknown;
}

interface PreflightWindow {
	durationSeconds?: unknown;
	limitCredits?: unknown;
	remainingCredits?: unknown;
}

interface Preflight {
	codingPlan?: {
		windows?: unknown;
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Literal, or `$ENV_VAR`; a leading `!command` is never executed by this probe. */
function resolveSecret(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	if (value.startsWith("!")) return undefined;
	const text = value.startsWith("$") ? process.env[value.slice(1)] : value;
	const trimmed = text?.trim();
	return trimmed ? trimmed : undefined;
}

function resolveApiUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "https:") return undefined;
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/$/, "");
	} catch {
		return undefined;
	}
}

function resolveProviders(value: unknown): Set<string> {
	const list = Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		: [];
	const ids = list.length > 0 ? list : DEFAULT_PROVIDERS;
	return new Set(ids.map(id => id.trim()));
}

function resolveRefreshInterval(value: unknown): number {
	const ms = Number(value);
	return Number.isFinite(ms) && ms >= MIN_REFRESH_MS ? ms : DEFAULT_REFRESH_MS;
}

async function loadConfig(): Promise<UsageConfig | undefined> {
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
	} catch {
		raw = undefined;
	}
	// A missing/invalid file is not fatal: the environment can still supply the key.
	const file = isObject(raw) ? raw : {};
	const controlKey =
		resolveSecret(file.controlKey) ?? resolveSecret(process.env.OPENDESIGN_CONTROL_KEY);
	if (!controlKey) return undefined;
	const apiUrl =
		resolveApiUrl(file.apiUrl) ??
		resolveApiUrl(process.env.OPENDESIGN_API_URL) ??
		DEFAULT_API_URL;
	const workspaceId =
		typeof file.workspaceId === "string" && file.workspaceId.trim()
			? file.workspaceId.trim()
			: undefined;
	return {
		controlKey,
		apiUrl,
		providers: resolveProviders(file.providers),
		workspaceId,
		refreshIntervalMs: resolveRefreshInterval(file.refreshIntervalMs),
	};
}

async function getJson<T>(path: string, cfg: UsageConfig): Promise<T | undefined> {
	try {
		const res = await fetch(`${cfg.apiUrl}${path}`, {
			headers: { Accept: "application/json", Authorization: `Bearer ${cfg.controlKey}` },
			redirect: "error",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!res.ok) return undefined;
		return (await res.json()) as T;
	} catch {
		return undefined;
	}
}

/** Remaining share of a quota window, clamped to 0–100. */
function remainingPercent(remaining: unknown, limit: unknown): number | undefined {
	const r = Number(remaining);
	const l = Number(limit);
	if (!Number.isFinite(r) || !Number.isFinite(l) || l <= 0 || r < 0) return undefined;
	return Math.min(100, Math.max(0, Math.round((r / l) * 100)));
}

function formatWindowLabel(durationSeconds: unknown): string | undefined {
	const seconds = Number(durationSeconds);
	if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
	const hours = seconds / 3600;
	if (Number.isInteger(hours) && hours % 24 === 0) return `${hours / 24}d`;
	if (Number.isInteger(hours)) return `${hours}h`;
	const minutes = Math.round(seconds / 60);
	return minutes > 0 ? `${minutes}m` : undefined;
}

function isActiveProvider(ctx: ExtensionContext, cfg: UsageConfig): boolean {
	const provider = ctx.model?.provider;
	return typeof provider === "string" && cfg.providers.has(provider);
}

function clearStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
}

let cachedWorkspaceId: string | undefined;

async function resolveWorkspaceId(cfg: UsageConfig): Promise<string | undefined> {
	if (cfg.workspaceId) return cfg.workspaceId;
	if (cachedWorkspaceId) return cachedWorkspaceId;
	const current = await getJson<WorkspaceCurrent>("/api/v1/workspaces/current", cfg);
	const id =
		typeof current?.activeWorkspaceId === "string" && current.activeWorkspaceId.trim()
			? current.activeWorkspaceId.trim()
			: typeof current?.workspaceId === "string" && current.workspaceId.trim()
				? current.workspaceId.trim()
				: undefined;
	if (id) cachedWorkspaceId = id;
	return id;
}

async function poll(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const cfg = await loadConfig();
	if (!cfg || !isActiveProvider(ctx, cfg)) {
		clearStatus(ctx);
		return;
	}

	const workspaceId = await resolveWorkspaceId(cfg);
	if (!workspaceId) return;
	const modelId = ctx.model?.id;
	const query = typeof modelId === "string" && modelId ? `?modelId=${encodeURIComponent(modelId)}` : "";
	const preflight = await getJson<Preflight>(
		`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/billing/preflight${query}`,
		cfg,
	);
	if (!preflight) {
		// A cached workspace that no longer answers (moved/deleted) should be re-resolved next time.
		if (!cfg.workspaceId) cachedWorkspaceId = undefined;
		return;
	}

	const windows = Array.isArray(preflight.codingPlan?.windows)
		? (preflight.codingPlan.windows as unknown[])
		: [];
	const parts = windows
		.map(window => (isObject(window) ? window : undefined))
		.flatMap(window => {
			if (!window) return [];
			const label = formatWindowLabel(window.durationSeconds);
			const percent = remainingPercent(window.remainingCredits, window.limitCredits);
			if (!label || percent === undefined) return [];
			return [{ seconds: Number(window.durationSeconds), text: `${label}:${percent}%`, percent }];
		})
		.sort((a, b) => a.seconds - b.seconds);

	if (parts.length === 0) {
		clearStatus(ctx);
		return;
	}

	// A single theme span keeps the spaces inside the text; the footer sanitizer trims
	// every plain segment, so per-window colors would strip the separators.
	const worst = Math.min(...parts.map(part => part.percent));
	const color = worst <= 0 ? "error" : worst <= 10 ? "warning" : "muted";

	// The model may have switched, or the session may have ended, while the request was in flight.
	if (!isActiveProvider(ctx, cfg)) return;
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, parts.map(part => part.text).join(" ")));
}

const inFlight = new WeakMap<ExtensionContext, Promise<void>>();

function refresh(ctx: ExtensionContext): Promise<void> {
	const existing = inFlight.get(ctx);
	if (existing) return existing;
	const pending = poll(ctx)
		.catch(() => {})
		.finally(() => {
			inFlight.delete(ctx);
		});
	inFlight.set(ctx, pending);
	return pending;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let sessionToken = 0;
	let lastAgentEndRefresh = 0;

	function stopTimer(): void {
		sessionToken += 1;
		if (timer) clearTimeout(timer);
		timer = undefined;
	}

	function schedule(ctx: ExtensionContext, token: number, delayMs: number): void {
		if (token !== sessionToken) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => void cycle(ctx, token), delayMs);
	}

	async function cycle(ctx: ExtensionContext, token: number): Promise<void> {
		if (token !== sessionToken) return;
		await refresh(ctx);
		if (token !== sessionToken) return;
		const cfg = await loadConfig();
		schedule(ctx, token, cfg?.refreshIntervalMs ?? DEFAULT_REFRESH_MS);
	}

	pi.on("session_start", (_event, ctx) => {
		stopTimer();
		if (ctx.mode !== "tui") return;
		const token = sessionToken;
		void cycle(ctx, token);
	});

	pi.on("model_select", (_event, ctx) => {
		void refresh(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (Date.now() - lastAgentEndRefresh < AGENT_END_THROTTLE_MS) return;
		lastAgentEndRefresh = Date.now();
		void refresh(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopTimer();
		clearStatus(ctx);
	});
}
