import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * relay-balance: show the active relay provider's balance as a status.
 *
 * Looks up the current model's provider in ~/.pi/agent/relay-providers.json
 * (the file owned by the relay-providers extension), then polls
 * GET {baseUrl}/usage with the provider's apiKey and publishes the balance
 * (e.g. "$72.87") via setStatus under the "relay-balance" key. Only the
 * generic { remaining|balance, unit } response shape is supported; providers
 * not listed in the file (built-ins like kimi-coding) are ignored.
 *
 * Refreshes on session start, model switches, and a 5-minute timer.
 */

const STATUS_KEY = "relay-balance";
const CONFIG_PATH = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "relay-providers.json");

/** Tolerant reader: relay-providers remains the strict validator of the file. */
async function loadProvider(id: string): Promise<{ baseUrl: string; apiKey: string } | undefined> {
	try {
		const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as {
			providers?: Array<{ id?: unknown; baseUrl?: unknown; apiKey?: unknown }>;
		};
		const p = raw.providers?.find(candidate => candidate.id === id);
		if (typeof p?.baseUrl !== "string" || typeof p.apiKey !== "string") return undefined;
		// $ENV_VAR is resolved; a leading !command is never executed here.
		const key = p.apiKey.startsWith("$") ? process.env[p.apiKey.slice(1)] : p.apiKey.startsWith("!") ? undefined : p.apiKey;
		return key ? { baseUrl: p.baseUrl, apiKey: key } : undefined;
	} catch {
		return undefined;
	}
}

async function refresh(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const providerId = ctx.model?.provider;
	if (!providerId) return ctx.ui.setStatus(STATUS_KEY, undefined);
	const provider = await loadProvider(providerId);
	if (!provider) return ctx.ui.setStatus(STATUS_KEY, undefined);
	try {
		const url = new URL(provider.baseUrl);
		url.pathname = `${url.pathname.replace(/\/$/, "")}/usage`;
		url.search = "";
		url.hash = "";
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${provider.apiKey}` },
			redirect: "error",
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) return;
		const j = (await res.json()) as { remaining?: unknown; balance?: unknown; unit?: unknown };
		const amount = Number(j.remaining ?? j.balance);
		const unit = typeof j.unit === "string" ? j.unit : "USD";
		const symbol = unit === "USD" ? "$" : unit === "CNY" ? "¥" : `${unit} `;
		// The model may have switched while the request was in flight.
		if (Number.isFinite(amount) && ctx.model?.provider === providerId) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("muted", `${symbol}${amount.toFixed(2)}`));
		}
	} catch {
		/* keep the previous status on network errors */
	}
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		if (ctx.mode !== "tui") return;
		void refresh(ctx);
		timer = setInterval(() => void refresh(ctx), 5 * 60_000);
	});

	pi.on("model_select", (_event, ctx) => void refresh(ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
