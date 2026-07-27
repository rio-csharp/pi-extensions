import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

/**
 * relay-footer: show relay balance/quota in a compact status footer.
 *
 * Reads ~/.pi/agent/relay-providers.json, probes each provider's
 * {baseUrl}/usage endpoint (or a provider-specific override), and shows
 * remaining balance for providers that expose it.
 *
 * - Auto refresh every REFRESH_MINUTES
 * - /balance command: force refresh + breakdown notification
 * - Compact single-line footer: path · context% · balance · model
 *
 * Queries configured providers from relay-providers.json through generic
 * balance endpoints, plus Kimi usage from auth.json. The repository contains
 * no provider definitions or provider credentials.
 *
 * Footer shows the balance for the active configured provider, or Kimi usage
 * when the active model is Kimi.
 */

const REFRESH_MINUTES = 5;
const TIMEOUT_MS = 8000;
const STATUS_KEY = "relay-footer";

interface ProviderCfg {
  id: string;
  name?: string;
  baseUrl: string;
  apiKey?: string;
  /** Optional non-/usage balance endpoint configuration. Keep credentials local. */
  balanceType?: "rix";
  balanceAccessToken?: string;
  balanceUserId?: string;
  balanceUserHeader?: string;
  /** Matches relay-providers.json: hidden providers are not queried or shown. */
  hidden?: boolean;
}

interface BalanceInfo {
  label: string;
  amount: number;
  unit: string;
  plan?: string;
  /** Preformatted text; overrides label+amount rendering when set. */
  display?: string;
  /** Provider ids this balance applies to when matching the active model. */
  providerIds: string[];
}

function resolveKey(apiKey?: string): string | undefined {
  if (!apiKey) return undefined;
  if (apiKey.startsWith("$")) return process.env[apiKey.slice(1)];
  return apiKey;
}

function loadProviders(): ProviderCfg[] {
  try {
    const file = join(homedir(), ".pi", "agent", "relay-providers.json");
    const json = JSON.parse(readFileSync(file, "utf8"));
    // Re-read on every refresh so unhiding a provider makes its balance appear
    // without needing a special code path. hidden:true providers stay out of the footer.
    return ((json.providers ?? []) as ProviderCfg[]).filter((provider) => provider.hidden !== true);
  } catch {
    return [];
  }
}

function requestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
}

async function fetchBalance(p: ProviderCfg, signal: AbortSignal): Promise<BalanceInfo | null> {
  if (p.balanceType === "rix" && p.balanceAccessToken && p.balanceUserId) {
    return fetchRixBalance(p, {
      accessToken: p.balanceAccessToken,
      userId: p.balanceUserId,
      userHeader: p.balanceUserHeader,
    }, signal);
  }
  const key = resolveKey(p.apiKey);
  if (!key || !p.baseUrl) return null;
  try {
    const res = await fetch(p.baseUrl.replace(/\/$/, "") + "/usage", {
      headers: { Authorization: `Bearer ${key}` },
      signal: requestSignal(signal),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    const amount =
      typeof j.remaining === "number" ? j.remaining
      : typeof j.balance === "number" ? j.balance
      : null;
    if (amount === null) return null;
    return {
      label: p.name ?? p.id,
      amount,
      unit: typeof j.unit === "string" ? j.unit : "USD",
      plan: typeof j.planName === "string" ? j.planName : undefined,
      providerIds: [p.id],
    };
  } catch {
    return null;
  }
}

async function fetchRixBalance(
  p: ProviderCfg,
  cfg: { accessToken: string; userId: string; userHeader?: string },
  signal: AbortSignal,
): Promise<BalanceInfo | null> {
  try {
    const origin = new URL(p.baseUrl).origin;
    const res = await fetch(`${origin}/api/user/self`, {
      headers: { Authorization: cfg.accessToken, [cfg.userHeader ?? "Rix-Api-User"]: cfg.userId },
      signal: requestSignal(signal),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const j = JSON.parse(text) as { data?: { quota?: number } };
    if (typeof j.data?.quota !== "number") return null;
    // new-api quota unit: 500000 = $1
    return { label: p.name ?? p.id, amount: j.data.quota / 500000, unit: "USD", providerIds: [p.id] };
  } catch {
    return null;
  }
}

async function fetchKimiBalance(signal: AbortSignal): Promise<BalanceInfo | null> {
  try {
    const authFile = join(homedir(), ".pi", "agent", "auth.json");
    const auth = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, { key?: string }>;
    const key = auth["kimi-coding"]?.key;
    if (!key) return null;
    const res = await fetch("https://api.kimi.com/coding/v1/usages", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: requestSignal(signal),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      usage?: { limit?: string; remaining?: string };
      limits?: Array<{ detail?: { limit?: string; remaining?: string } }>;
    };
    const usedPct = (l?: string, r?: string) => {
      const limit = Number(l), remaining = Number(r);
      if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) return null;
      return Math.round(((limit - remaining) / limit) * 100);
    };
    const wk = usedPct(j.usage?.limit, j.usage?.remaining);
    const fiveH = usedPct(j.limits?.[0]?.detail?.limit, j.limits?.[0]?.detail?.remaining);
    if (wk === null && fiveH === null) return null;
    const parts = [];
    if (fiveH !== null) parts.push(`5h:${fiveH}%`);
    if (wk !== null) parts.push(`wk:${wk}%`);
    return {
      label: "Kimi",
      amount: 0,
      unit: "",
      // No provider name: footer already shows the active model/provider.
      display: parts.join(" "),
      providerIds: ["kimi-coding"],
    };
  } catch {
    return null;
  }
}

function fmt(b: BalanceInfo): string {
  if (b.display) return b.display;
  // Amount only — provider/model is already shown on the right side of the footer.
  const sym = b.unit === "USD" ? "$" : b.unit === "CNY" ? "¥" : `${b.unit} `;
  return `${sym}${b.amount.toFixed(2)}`;
}

function balanceForProvider(balances: BalanceInfo[], providerId: string | undefined): BalanceInfo | undefined {
  if (!providerId) return undefined;
  return balances.find((balance) => balance.providerIds.includes(providerId));
}

function applyBalanceStatus(ctx: ExtensionContext, balances: BalanceInfo[]): void {
  const current = balanceForProvider(balances, ctx.model?.provider);
  if (!current) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("muted", fmt(current)));
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/**
 * Single-line footer: path/branch · context% · balance · model.
 * Skips cumulative ↑/↓/cache/cost token stats.
 */
function installBalanceFooter(ctx: ExtensionContext): void {
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsub = footerData.onBranchChange(() => tui.requestRender());
    return {
      dispose: unsub,
      invalidate() {},
      render(width: number): string[] {
        const model = ctx.model;

        const contextUsage = ctx.getContextUsage();
        const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
        const contextPercentValue = contextUsage?.percent ?? 0;
        const contextPercent = contextUsage?.percent !== null && contextUsage?.percent !== undefined
          ? contextPercentValue.toFixed(1)
          : "?";

        let pwd = formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
        const branch = footerData.getGitBranch();
        if (branch) pwd = `${pwd} (${branch})`;
        const sessionName = ctx.sessionManager.getSessionName();
        if (sessionName) pwd = `${pwd} • ${sessionName}`;

        const contextPercentDisplay = contextPercent === "?"
          ? `?/${formatTokens(contextWindow)}`
          : `${contextPercent}%/${formatTokens(contextWindow)}`;
        let contextPercentStr: string;
        if (contextPercentValue > 90) contextPercentStr = theme.fg("error", contextPercentDisplay);
        else if (contextPercentValue > 70) contextPercentStr = theme.fg("warning", contextPercentDisplay);
        else contextPercentStr = contextPercentDisplay;

        const leftParts = [pwd, contextPercentStr];
        const balanceText = footerData.getExtensionStatuses().get(STATUS_KEY);
        if (balanceText) leftParts.push(sanitizeStatusText(balanceText));

        let statsLeft = leftParts.join(" · ");
        const modelName = model?.id || "no-model";
        let statsLeftWidth = visibleWidth(statsLeft);
        if (statsLeftWidth > width) {
          statsLeft = truncateToWidth(statsLeft, width, "...");
          statsLeftWidth = visibleWidth(statsLeft);
        }

        const minPadding = 2;
        let rightSideWithoutProvider = modelName;
        if (model?.reasoning) {
          const thinkingLevel = ctx.thinkingLevel || "off";
          rightSideWithoutProvider =
            thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
        }

        let rightSide = rightSideWithoutProvider;
        if (footerData.getAvailableProviderCount() > 1 && model) {
          rightSide = `(${model.provider}) ${rightSideWithoutProvider}`;
          if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
            rightSide = rightSideWithoutProvider;
          }
        }

        const rightSideWidth = visibleWidth(rightSide);
        const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
        let statsLine: string;
        if (totalNeeded <= width) {
          const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
          statsLine = statsLeft + padding + rightSide;
        } else {
          const availableForRight = width - statsLeftWidth - minPadding;
          if (availableForRight > 0) {
            const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
            const truncatedRightWidth = visibleWidth(truncatedRight);
            const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
            statsLine = statsLeft + padding + truncatedRight;
          } else {
            statsLine = statsLeft;
          }
        }

        // Dim path/balance; keep context color codes intact by dimming the plain prefix only.
        const dimStatsLeft = theme.fg("dim", statsLeft);
        const remainder = statsLine.slice(statsLeft.length);
        const dimRemainder = theme.fg("dim", remainder);
        const lines = [dimStatsLeft + dimRemainder];

        // Keep ordinary extension statuses compact, but render each running
        // subagent on its own line below this one-line balance footer.
        const statusEntries = Array.from(footerData.getExtensionStatuses().entries())
          .filter(([key]) => key !== STATUS_KEY)
          .sort(([a], [b]) => a.localeCompare(b));
        const otherStatuses = statusEntries
          .filter(([key]) => !key.startsWith("subagent-status-"))
          .map(([, text]) => sanitizeStatusText(text));
        if (otherStatuses.length > 0) {
          lines.push(truncateToWidth(otherStatuses.join(" "), width, theme.fg("dim", "...")));
        }
        for (const [, text] of statusEntries.filter(([key]) => key.startsWith("subagent-status-"))) {
          lines.push(truncateToWidth(sanitizeStatusText(text), width, theme.fg("dim", "...")));
        }

        return lines;
      },
    };
  });
}

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let lifecycleController: AbortController | undefined;
  let refreshInFlight: Promise<BalanceInfo[]> | undefined;
  let last: BalanceInfo[] = [];
  let footerInstalled = false;

  async function refresh(ctx: ExtensionContext, signal: AbortSignal): Promise<BalanceInfo[]> {
    if (!ctx.hasUI || signal.aborted) return last;
    const providers = loadProviders();
    const results = await Promise.all([
      ...providers.map((provider) => fetchBalance(provider, signal)),
      fetchKimiBalance(signal),
    ]);
    if (signal.aborted) return last;

    last = results.filter((balance): balance is BalanceInfo => balance !== null);
    // setStatus stores only the active model's balance and triggers re-render.
    applyBalanceStatus(ctx, last);
    return last;
  }

  function refreshInBackground(ctx: ExtensionContext): Promise<BalanceInfo[]> | undefined {
    const signal = lifecycleController?.signal;
    if (!signal || signal.aborted) return undefined;
    if (refreshInFlight) return refreshInFlight;

    const task = refresh(ctx, signal).finally(() => {
      if (refreshInFlight === task) refreshInFlight = undefined;
    });
    refreshInFlight = task;
    return task;
  }

  pi.on("session_start", (_event, ctx) => {
    lifecycleController?.abort();
    lifecycleController = new AbortController();
    refreshInFlight = undefined;
    if (timer) clearInterval(timer);
    timer = undefined;

    if (ctx.mode !== "tui") return;

    // Reinstall on every session_start so the footer always closes over a live ctx
    // (model/thinkingLevel/sessionManager getters stay current after reload/resume).
    installBalanceFooter(ctx);
    footerInstalled = true;

    timer = setInterval(() => {
      void refreshInBackground(ctx)?.catch(() => {});
    }, REFRESH_MINUTES * 60 * 1000);

    // Refresh after both startup and reload. This is intentionally fire-and-forget:
    // session startup/reload returns immediately while the footer updates later.
    void refreshInBackground(ctx)?.catch(() => {});
  });

  // Switching models only re-filters the cached balances; no extra network call.
  pi.on("model_select", (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    applyBalanceStatus(ctx, last);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    lifecycleController?.abort();
    lifecycleController = undefined;
    refreshInFlight = undefined;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (footerInstalled && ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setFooter(undefined);
      footerInstalled = false;
    }
  });

  pi.registerCommand("balance", {
    description: "Refresh and show the current model's relay balance",
    handler: async (_args, ctx) => {
      const signal = lifecycleController?.signal;
      const task = refreshInBackground(ctx);
      if (!task || !signal) {
        ctx.ui.notify("Balance refresh is unavailable in this session", "warning");
        return;
      }

      ctx.ui.notify("Refreshing relay balances in the background...", "info");
      void task.then(balances => {
        if (signal.aborted) return;
        const current = balanceForProvider(balances, ctx.model?.provider);
        if (!current) {
          ctx.ui.notify("No balance endpoint for the current model provider", "info");
          return;
        }
        ctx.ui.notify(fmt(current) + (current.plan ? ` (${current.plan})` : ""), "info");
      }).catch(error => {
        if (!signal.aborted) {
          ctx.ui.notify(`Balance refresh failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      });
    },
  });
}
