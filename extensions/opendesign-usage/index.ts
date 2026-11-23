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

async function getJson<T>(path: string, cfg: UsageConfig, signal: AbortSignal): Promise<T | undefined> {
	try {
		const res = await fetch(`${cfg.apiUrl}${path}`, {
			headers: { Accept: "application/json", Authorization: `Bearer ${cfg.controlKey}` },
			redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
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

function clearStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
}

interface UsageSession {
	ctx: ExtensionContext;
	manager: ExtensionContext["sessionManager"];
	config?: UsageConfig;
	cachedWorkspaceId?: string;
	lastAgentEndRefresh: number;
	pending?: { controller: AbortController; promise: Promise<void> };
}

function sameConfig(a: UsageConfig | undefined, b: UsageConfig | undefined): boolean {
	if (!a || !b) return a === b;
	return a.controlKey === b.controlKey && a.apiUrl === b.apiUrl &&
		a.workspaceId === b.workspaceId && a.refreshIntervalMs === b.refreshIntervalMs &&
		a.providers.size === b.providers.size && [...a.providers].every(id => b.providers.has(id));
}

async function resolveWorkspaceId(session: UsageSession, cfg: UsageConfig, signal: AbortSignal): Promise<string | undefined> {
	if (cfg.workspaceId) return cfg.workspaceId;
	if (session.cachedWorkspaceId) return session.cachedWorkspaceId;
	const current = await getJson<WorkspaceCurrent>("/api/v1/workspaces/current", cfg, signal);
	if (signal.aborted) return undefined;
	const id =
		typeof current?.activeWorkspaceId === "string" && current.activeWorkspaceId.trim()
			? current.activeWorkspaceId.trim()
			: typeof current?.workspaceId === "string" && current.workspaceId.trim()
				? current.workspaceId.trim()
				: undefined;
	if (id) session.cachedWorkspaceId = id;
	return id;
}

async function poll(session: UsageSession, signal: AbortSignal): Promise<void> {
	const ctx = session.ctx;
	if (!ctx.hasUI) return;
	const model = ctx.model;
	const provider = model?.provider;
	const modelId = model?.id;
	const cfg = await loadConfig();
	if (signal.aborted || ctx.model?.provider !== provider || ctx.model?.id !== modelId) return;
	if (!sameConfig(session.config, cfg)) session.cachedWorkspaceId = undefined;
	session.config = cfg;
	if (!cfg || !provider || !cfg.providers.has(provider)) {
		clearStatus(ctx);
		return;
	}

	const workspaceId = await resolveWorkspaceId(session, cfg, signal);
	if (signal.aborted || !workspaceId) return;
	const query = modelId ? `?modelId=${encodeURIComponent(modelId)}` : "";
	const preflight = await getJson<Preflight>(
		`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/billing/preflight${query}`,
		cfg,
		signal,
	);
	if (signal.aborted || ctx.model?.provider !== provider || ctx.model?.id !== modelId) return;
	if (!preflight) {
		// A cached workspace that no longer answers (moved/deleted) should be re-resolved next time.
		if (!cfg.workspaceId) session.cachedWorkspaceId = undefined;
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

	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, parts.map(part => part.text).join(" ")));
}

function refresh(session: UsageSession): Promise<void> {
	if (session.pending) return session.pending.promise;
	const controller = new AbortController();
	const promise = poll(session, controller.signal)
		.catch(() => {})
		.finally(() => {
			if (session.pending?.controller === controller) session.pending = undefined;
		});
	session.pending = { controller, promise };
	return promise;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let active: UsageSession | undefined;

	function stop(): void {
		active?.pending?.controller.abort();
		active = undefined;
		clearTimeout(timer);
		timer = undefined;
	}

	async function cycle(session: UsageSession): Promise<void> {
		if (active !== session) return;
		do {
			await refresh(session);
		} while (active === session && session.pending);
		if (active !== session) return;
		timer = setTimeout(() => void cycle(session), session.config?.refreshIntervalMs ?? DEFAULT_REFRESH_MS);
	}

	pi.on("session_start", (_event, ctx) => {
		stop();
		active = { ctx, manager: ctx.sessionManager, lastAgentEndRefresh: -Infinity };
		if (ctx.mode === "tui") void cycle(active);
	});

	pi.on("model_select", (event, ctx) => {
		if (!active || active.manager !== ctx.sessionManager) return;
		active.pending?.controller.abort();
		active.pending = undefined;
		active.ctx = ctx;
		if (event.previousModel?.provider !== event.model.provider || event.previousModel?.id !== event.model.id) {
			clearStatus(ctx);
		}
		void refresh(active);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!active || active.manager !== ctx.sessionManager || !ctx.hasUI) return;
		const now = Date.now();
		if (now - active.lastAgentEndRefresh < AGENT_END_THROTTLE_MS) return;
		active.lastAgentEndRefresh = now;
		void refresh(active);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!active || active.manager !== ctx.sessionManager) return;
		stop();
		clearStatus(ctx);
	});
}
