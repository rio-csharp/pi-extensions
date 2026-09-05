import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = "kimi-coding";
const STATUS_KEY = "kimi-usage";
const USAGE_URL = "https://api.kimi.com/coding/v1/usages";

let lastFetch = 0;
// Usage percentages move slowly (5h/weekly windows); 5 minutes is real-time enough.
const MIN_INTERVAL_MS = 5 * 60_000;

function usedPercent(limit: unknown, remaining: unknown): number | null {
	const l = Number(limit), r = Number(remaining);
	return l > 0 && r >= 0 ? Math.min(100, Math.max(0, Math.round(((l - r) / l) * 100))) : null;
}

async function refresh(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	if (ctx.model?.provider !== PROVIDER) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	try {
		lastFetch = Date.now();
		const key = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
		if (!key) return;
		const res = await fetch(USAGE_URL, {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) return;
		const j = (await res.json()) as {
			usage?: { limit?: unknown; remaining?: unknown };
			limits?: Array<{ detail?: { limit?: unknown; remaining?: unknown } }>;
		};
		const fiveH = usedPercent(j.limits?.[0]?.detail?.limit, j.limits?.[0]?.detail?.remaining);
		const wk = usedPercent(j.usage?.limit, j.usage?.remaining);
		const text = [fiveH !== null && `5h:${fiveH}%`, wk !== null && `wk:${wk}%`].filter(Boolean).join(" ");
		// The model may have switched while the request was in flight.
		if (ctx.model?.provider === PROVIDER && text) ctx.ui.setStatus(STATUS_KEY, text);
	} catch {
	}
}

export default function (pi: ExtensionAPI) {
	const throttledRefresh = (ctx: ExtensionContext) => {
		if (Date.now() - lastFetch < MIN_INTERVAL_MS) return;
		void refresh(ctx);
	};
	pi.on("session_start", (_event, ctx) => void refresh(ctx));
	pi.on("model_select", (_event, ctx) => void refresh(ctx));
	pi.on("agent_end", (_event, ctx) => throttledRefresh(ctx));
}
