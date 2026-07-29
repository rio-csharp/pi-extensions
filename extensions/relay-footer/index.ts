import { readStoredCredential, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

/**
 * relay-footer: show relay balance/quota in a compact status footer.
 *
 * Reads ~/.pi/agent/relay-providers.json, probes the active provider's
 * opted-in generic/Rix balance endpoint (or built-in Kimi usage unless opted
 * out), and shows remaining balance for providers that expose it.
 *
 * - Auto refresh every REFRESH_MINUTES
 * - /balance command: force refresh + breakdown notification
 * - Compact single-line footer: path · context% · balance · model
 *
 * Queries the active configured provider through its local balance settings,
 * plus built-in Kimi usage when Kimi is active. Kimi authentication is bound
 * to Pi's unmodified official provider and provider-scoped credential source.
 * The repository contains no relay provider definitions or credentials.
 *
 * Footer shows the balance for the active configured provider, or Kimi usage
 * when the active model is Kimi.
 */

const REFRESH_MINUTES = 5;
const TIMEOUT_MS = 8000;
const STATUS_KEY = "relay-footer";
const KIMI_PROVIDER_ID = "kimi-coding";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const MAX_LABEL_LENGTH = 48;
const MAX_PLAN_LENGTH = 80;
const MAX_UNIT_LENGTH = 16;

interface ProviderCfg {
  id: string;
  name?: string;
  baseUrl: string;
  apiKey?: string;
  /**
   * Match relay-providers: plain HTTP is an explicit opt-in and is limited to
   * localhost or literal loopback/private/link-local addresses.
   */
  allowInsecureHttp?: boolean;
  /** Optional non-/usage balance endpoint configuration. Keep credentials local. */
  balanceType?: "rix";
  balanceAccessToken?: string;
  balanceUserId?: string;
  balanceUserHeader?: string;
  /** Enable generic/Rix balance queries for this provider. Default: false. */
  balanceEnabled?: boolean;
  /** Matches relay-providers.json: hidden providers are not queried or shown. */
  hidden?: boolean;
}

interface BalanceInfo {
  amount: number;
  unit: string;
  plan?: string;
  /** Preformatted text; overrides amount rendering when set. */
  display?: string;
}

function resolveKey(value?: string): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("$")) return process.env[value.slice(1)];
  return value;
}

/** Remove terminal string controls as a whole, including unterminated forms. */
function stripTerminalStrings(value: string): string {
  return value
    // OSC (BEL or ST terminated), including its C1 form.
    .replace(/(?:\x1B\]|\x9D)[\s\S]*?(?:\x07|\x1B\\|\x9C|$)/g, "")
    // DCS, SOS, PM and APC (ST terminated), including their C1 forms.
    .replace(/(?:\x1B[P_X^]|[\x90\x98\x9E\x9F])[\s\S]*?(?:\x1B\\|\x9C|$)/g, "");
}

/** Strip terminal control sequences/characters before untrusted text reaches the TUI. */
function sanitizeExternalText(value: string, maxLength: number): string {
  const withoutSequences = stripTerminalStrings(value)
    // CSI and remaining ESC sequences, including incomplete trailing CSI.
    .replace(/(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(?:\x1B\[|\x9B)[0-?]*[ -/]*$/g, "")
    .replace(/\x1B[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1F\x7F-\x9F]/g, " ")
    // Bidi marks, embeddings, overrides, isolates and deprecated isolates can
    // visually reorder terminal output even though they are printable Unicode.
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u206F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(withoutSequences).slice(0, maxLength).join("");
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [first, second] = octets as [number, number, number, number];
  return first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

/** Keep this in lockstep with relay-providers' local/private HTTP semantics. */
function isPrivateHttpHostname(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (isPrivateIpv4(normalized)) return true;
  return normalized.includes(":") && (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized)
  );
}

/**
 * Validate the transport before constructing an authenticated balance request.
 * Returning a URL rather than the original string also prevents userinfo and
 * fragments from being smuggled into endpoint concatenation.
 */
function balanceEndpoint(p: ProviderCfg, endpoint: "/usage" | "/api/user/self"): URL {
  const base = new URL(p.baseUrl);
  if ((base.protocol !== "http:" && base.protocol !== "https:") || !base.hostname) {
    throw new Error("Balance baseUrl must be an absolute HTTP(S) URL");
  }
  if (base.username || base.password) {
    throw new Error("Balance baseUrl must not contain URL userinfo");
  }
  if (base.protocol === "http:" && (p.allowInsecureHttp !== true || !isPrivateHttpHostname(base.hostname))) {
    throw new Error("Plain HTTP balance requests require allowInsecureHttp:true and a localhost or literal private address");
  }

  if (endpoint === "/api/user/self") return new URL(endpoint, `${base.origin}/`);
  base.pathname = `${base.pathname.replace(/\/$/, "")}${endpoint}`;
  base.search = "";
  base.hash = "";
  return base;
}

interface RelayFooterCfg {
  providers: ProviderCfg[];
  /** Built-in Kimi polling defaults on; this top-level flag provides an opt-out. */
  kimiBalanceEnabled?: boolean;
}

function loadConfig(): RelayFooterCfg {
  try {
    const file = join(AGENT_DIR, "relay-providers.json");
    const json = JSON.parse(readFileSync(file, "utf8")) as { providers?: unknown; kimiBalanceEnabled?: unknown };
    return {
      providers: Array.isArray(json.providers) ? json.providers as ProviderCfg[] : [],
      kimiBalanceEnabled: typeof json.kimiBalanceEnabled === "boolean" ? json.kimiBalanceEnabled : undefined,
    };
  } catch {
    return { providers: [] };
  }
}

function localProvider(config: RelayFooterCfg, providerId: string): ProviderCfg | undefined {
  return config.providers.find((provider) => provider?.id === providerId);
}

function requestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
}

async function fetchBalance(p: ProviderCfg, signal: AbortSignal): Promise<BalanceInfo | null> {
  const rixAccessToken = resolveKey(p.balanceAccessToken);
  const rixUserId = resolveKey(p.balanceUserId);
  if (p.balanceType === "rix" && rixAccessToken && rixUserId) {
    return fetchRixBalance(p, {
      accessToken: rixAccessToken,
      userId: rixUserId,
      userHeader: p.balanceUserHeader,
    }, signal);
  }
  const key = resolveKey(p.apiKey);
  if (!key || !p.baseUrl) return null;
  try {
    const res = await fetch(p.baseUrl.replace(/\/$/, "") + "/usage", {
      headers: { Authorization: `Bearer ${key}` },
      redirect: "error",
      signal: requestSignal(signal),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    const amount =
      typeof j.remaining === "number" ? j.remaining
      : typeof j.balance === "number" ? j.balance
      : null;
    if (amount === null || !Number.isFinite(amount)) return null;
    const unit = typeof j.unit === "string" ? sanitizeExternalText(j.unit, MAX_UNIT_LENGTH) : "USD";
    const plan = typeof j.planName === "string" ? sanitizeExternalText(j.planName, MAX_PLAN_LENGTH) : undefined;
    return {
      amount,
      unit: unit || "USD",
      plan: plan || undefined,
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
    const userHeader = cfg.userHeader?.trim() || "Rix-Api-User";
    // Keep the compatible local Rix fields, but reject an invalid dynamic header name.
    new Headers({ [userHeader]: cfg.userId });
    const res = await fetch(`${origin}/api/user/self`, {
      headers: { Authorization: cfg.accessToken, [userHeader]: cfg.userId },
      redirect: "error",
      signal: requestSignal(signal),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { quota?: number } };
    const quota = j.data?.quota;
    if (typeof quota !== "number" || !Number.isFinite(quota)) return null;
    // new-api quota unit: 500000 = $1
    const amount = quota / 500000;
    if (!Number.isFinite(amount)) return null;
    return { amount, unit: "USD" };
  } catch {
    return null;
  }
}

function hasOrigin(value: string | undefined, expected: string): boolean {
  if (!value) return false;
  try {
    return new URL(value).origin === expected;
  } catch {
    return false;
  }
}

/**
 * Prove that the active Kimi provider/model still belongs to the built-in
 * official origin. A dynamic provider registration is an override even when
 * it happens to reuse the official URL, so its credential must not be sent to
 * Kimi's first-party usage endpoint.
 */
function ownsOfficialKimiOrigin(ctx: ExtensionContext): boolean {
  const officialOrigin = new URL(KIMI_USAGE_URL).origin;
  const provider = ctx.modelRegistry.getProvider(KIMI_PROVIDER_ID);
  const model = ctx.model;
  const builtInModels = provider?.getModels();
  const matchesBuiltInModel = model !== undefined && builtInModels?.some((candidate) =>
    candidate.provider === KIMI_PROVIDER_ID &&
    candidate.id === model.id &&
    candidate.api === model.api &&
    candidate.baseUrl === model.baseUrl
  ) === true;
  return provider?.id === KIMI_PROVIDER_ID &&
    model?.provider === KIMI_PROVIDER_ID &&
    matchesBuiltInModel &&
    hasOrigin(provider.baseUrl, officialOrigin) &&
    hasOrigin(model.baseUrl, officialOrigin) &&
    ctx.modelRegistry.getRegisteredProviderConfig(KIMI_PROVIDER_ID) === undefined &&
    ctx.modelRegistry.getRegisteredNativeProvider(KIMI_PROVIDER_ID) === undefined;
}

function allowedKimiAuthSource(
  status: ReturnType<ExtensionContext["modelRegistry"]["getProviderAuthStatus"]>,
  resolvedSource: string | undefined,
): boolean {
  if (!status.configured) return false;
  if (status.source === "stored") {
    return resolvedSource === "OAuth" || resolvedSource === "stored credential";
  }
  return status.source === "environment" &&
    status.label === "KIMI_API_KEY" &&
    resolvedSource === "KIMI_API_KEY";
}

/** Build an Authorization-only header set from one provider-scoped token. */
function kimiAuthorizationHeader(token: string): Record<"Authorization", string> | undefined {
  if (!token) return undefined;
  try {
    const validated = new Headers({ Authorization: `Bearer ${token}` });
    const normalized = validated.get("Authorization");
    return normalized ? { Authorization: normalized } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve only credentials Pi attributes to the unmodified official provider.
 * Runtime, models.json, extension, command, and fallback key sources are
 * deliberately ineligible. Resolved request headers and apiKey are never
 * copied: stored credentials are read by provider id, and OAuth resolution is
 * used only to refresh the provider-owned token before that scoped re-read.
 */
async function officialKimiHeaders(ctx: ExtensionContext): Promise<Record<"Authorization", string> | undefined> {
  if (!ownsOfficialKimiOrigin(ctx)) return undefined;

  const status = ctx.modelRegistry.getProviderAuthStatus(KIMI_PROVIDER_ID);
  if (!status.configured) return undefined;
  if (status.source === "stored") {
    let credential = readStoredCredential(KIMI_PROVIDER_ID, join(AGENT_DIR, "auth.json"));
    if (credential?.type === "oauth") {
      try {
        const resolved = await ctx.modelRegistry.getProviderAuth(KIMI_PROVIDER_ID);
        if (!resolved || !allowedKimiAuthSource(status, resolved.source)) return undefined;
      } catch {
        return undefined;
      }
      credential = readStoredCredential(KIMI_PROVIDER_ID, join(AGENT_DIR, "auth.json"));
    }
    if (credential?.type === "oauth") return kimiAuthorizationHeader(credential.access);
    if (credential?.type === "api_key" && credential.key) return kimiAuthorizationHeader(credential.key);
    return undefined;
  }
  if (status.source === "environment" && status.label === "KIMI_API_KEY" && process.env.KIMI_API_KEY) {
    try {
      const resolved = await ctx.modelRegistry.getProviderAuth(KIMI_PROVIDER_ID);
      if (!resolved || !allowedKimiAuthSource(status, resolved.source)) return undefined;
    } catch {
      return undefined;
    }
    return kimiAuthorizationHeader(process.env.KIMI_API_KEY);
  }
  return undefined;
}

async function fetchKimiBalance(ctx: ExtensionContext, signal: AbortSignal): Promise<BalanceInfo | null> {
  try {
    const headers = await officialKimiHeaders(ctx);
    if (!headers) return null;

    const res = await fetch(KIMI_USAGE_URL, {
      headers,
      redirect: "error",
      signal: requestSignal(signal),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      usage?: { limit?: string | number; remaining?: string | number };
      limits?: Array<{ detail?: { limit?: string | number; remaining?: string | number } }>;
    };
    const usedPct = (l?: string | number, r?: string | number) => {
      const limit = Number(l), remaining = Number(r);
      if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0 || remaining < 0) return null;
      const percent = Math.round(((limit - remaining) / limit) * 100);
      return Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : null;
    };
    const wk = usedPct(j.usage?.limit, j.usage?.remaining);
    const fiveH = usedPct(j.limits?.[0]?.detail?.limit, j.limits?.[0]?.detail?.remaining);
    if (wk === null && fiveH === null) return null;
    const parts = [];
    if (fiveH !== null) parts.push(`5h:${fiveH}%`);
    if (wk !== null) parts.push(`wk:${wk}%`);
    return {
      amount: 0,
      unit: "",
      // No provider name: footer already shows the active model/provider.
      display: parts.join(" "),
    };
  } catch {
    return null;
  }
}

function fmt(b: BalanceInfo): string {
  if (b.display) return sanitizeExternalText(b.display, 120);
  if (!Number.isFinite(b.amount)) return "?";
  // Amount only — provider/model is already shown on the right side of the footer.
  const unit = sanitizeExternalText(b.unit, MAX_UNIT_LENGTH);
  const sym = unit === "USD" ? "$" : unit === "CNY" ? "¥" : `${unit} `;
  return `${sym}${b.amount.toFixed(2)}`;
}

function applyBalanceStatus(ctx: ExtensionContext, balances: Map<string, BalanceInfo>): void {
  const current = ctx.model?.provider ? balances.get(ctx.model.provider) : undefined;
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
  // These values can include extension/network text. Preserve only SGR color
  // codes produced by Pi's theme; sanitize every plain segment fully.
  const sgr = /\x1B\[[0-9;]*m/g;
  let result = "";
  let offset = 0;
  for (const match of text.matchAll(sgr)) {
    result += sanitizeExternalText(text.slice(offset, match.index), Number.MAX_SAFE_INTEGER);
    result += match[0];
    offset = (match.index ?? 0) + match[0].length;
  }
  result += sanitizeExternalText(text.slice(offset), Number.MAX_SAFE_INTEGER);
  return result.trim();
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
        const reportedContextPercent = contextUsage?.percent;
        // Provider usage can briefly report the pre-compaction prompt after Pi
        // has compacted the session. Treat impossible values as unknown instead
        // of rendering a misleading percentage above 100%.
        const contextPercentIsValid =
          reportedContextPercent !== null &&
          reportedContextPercent !== undefined &&
          Number.isFinite(reportedContextPercent) &&
          reportedContextPercent >= 0 &&
          reportedContextPercent <= 100;
        const contextPercentValue = contextPercentIsValid ? reportedContextPercent : 0;
        const contextPercent = contextPercentIsValid ? reportedContextPercent.toFixed(1) : "?";

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
        const modelName = model ? sanitizeExternalText(model.id, 96) || "unnamed-model" : "no-model";
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
          const providerName = sanitizeExternalText(model.provider, MAX_LABEL_LENGTH) || "unknown-provider";
          rightSide = `(${providerName}) ${rightSideWithoutProvider}`;
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
  const refreshesInFlight = new Map<string, Promise<BalanceInfo | null>>();
  const balancesByProvider = new Map<string, BalanceInfo>();
  let footerInstalled = false;

  async function refreshProvider(
    ctx: ExtensionContext,
    providerId: string,
    signal: AbortSignal,
  ): Promise<BalanceInfo | null> {
    if (!ctx.hasUI || signal.aborted) return balancesByProvider.get(providerId) ?? null;
    const config = loadConfig();
    const local = localProvider(config, providerId);
    let adapterEnabled = false;
    let balance: BalanceInfo | null = null;
    if (providerId === KIMI_PROVIDER_ID) {
      // Omission preserves the built-in adapter's historical enabled behavior.
      adapterEnabled = config.kimiBalanceEnabled !== false;
      if (adapterEnabled) balance = await fetchKimiBalance(ctx, signal);
    } else {
      adapterEnabled = local?.hidden !== true && local?.balanceEnabled === true;
      if (adapterEnabled && local) balance = await fetchBalance(local, signal);
    }
    if (signal.aborted) return balancesByProvider.get(providerId) ?? null;

    if (balance) balancesByProvider.set(providerId, balance);
    else balancesByProvider.delete(providerId);
    // The request may have completed after a model switch. Update only from the
    // provider-keyed cache, so stale completions cannot clear the active result.
    applyBalanceStatus(ctx, balancesByProvider);
    return balance;
  }

  function refreshInBackground(
    ctx: ExtensionContext,
    providerId: string | undefined = ctx.model?.provider,
  ): Promise<BalanceInfo | null> | undefined {
    const signal = lifecycleController?.signal;
    if (!providerId || !signal || signal.aborted) return undefined;
    const existing = refreshesInFlight.get(providerId);
    if (existing) return existing;

    const task = refreshProvider(ctx, providerId, signal).finally(() => {
      if (refreshesInFlight.get(providerId) === task) refreshesInFlight.delete(providerId);
    });
    refreshesInFlight.set(providerId, task);
    return task;
  }

  pi.on("session_start", (_event, ctx) => {
    lifecycleController?.abort();
    lifecycleController = new AbortController();
    refreshesInFlight.clear();
    balancesByProvider.clear();
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

  // Switching models immediately applies that provider's cache and starts or
  // joins only that provider's request; another provider cannot consume it.
  pi.on("model_select", (event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    applyBalanceStatus(ctx, balancesByProvider);
    void refreshInBackground(ctx, event.model.provider)?.catch(() => {});
  });

  pi.on("session_shutdown", (_event, ctx) => {
    lifecycleController?.abort();
    lifecycleController = undefined;
    refreshesInFlight.clear();
    balancesByProvider.clear();
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
      const providerId = ctx.model?.provider;
      const task = refreshInBackground(ctx, providerId);
      if (!task || !signal || !providerId) {
        ctx.ui.notify("Balance refresh is unavailable in this session", "warning");
        return;
      }

      const providerLabel = sanitizeExternalText(providerId, MAX_LABEL_LENGTH) || "unknown-provider";
      ctx.ui.notify("Refreshing the current provider balance in the background...", "info");
      void task.then(balance => {
        if (signal.aborted) return;
        if (!balance) {
          ctx.ui.notify("No enabled balance adapter or result for the requested provider", "info");
          return;
        }
        // Report the provider captured when /balance was invoked, even if the
        // active model changed while its provider-keyed request was in flight.
        const plan = balance.plan ? ` (${sanitizeExternalText(balance.plan, MAX_PLAN_LENGTH)})` : "";
        ctx.ui.notify(`${providerLabel}: ${fmt(balance)}${plan}`, "info");
      }).catch(error => {
        if (!signal.aborted) {
          const message = sanitizeExternalText(error instanceof Error ? error.message : String(error), 160);
          ctx.ui.notify(`Balance refresh failed: ${message || "unknown error"}`, "error");
        }
      });
    },
  });
}
