import {
  CONFIG_DIR_NAME,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  auth,
  discoverOAuthServerInfo,
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createServer, type Server as HttpServer } from "node:http";
import { readFile, writeFile, mkdir, access, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OAUTH_CALLBACK_HOST = "127.0.0.1";
const OAUTH_CALLBACK_PORT = 33418;
const OAUTH_CALLBACK_PATH = "/oauth/callback";
const OAUTH_CALLBACK_URL = `http://${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_DISCOVERY_PAGES = 100;
const MAX_DISCOVERY_ITEMS = 10_000;
const MAX_HTTP_REDIRECTS = 5;
const MAX_REMOTE_TEXT_LENGTH = 16_384;
const parsedRequestTimeout = Number(process.env.PI_MCP_REQUEST_TIMEOUT_MS ?? 15_000);
const MCP_REQUEST_TIMEOUT_MS = Number.isFinite(parsedRequestTimeout) && parsedRequestTimeout > 0
  ? parsedRequestTimeout
  : 15_000;

interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

interface OAuthConfig {
  authUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  redirectUri?: string;
  scope?: string;
  // Legacy fields are read once and migrated to ~/.pi/agent/.credentials.json.
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

interface PersistedOAuthCredential {
  serverName: string;
  serverUrl: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  expiresAt?: number;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

interface PersistedBearerCredential {
  serverName: string;
  serverUrl: string;
  token: string;
}

interface MCPCredentials {
  mcpOAuth: Record<string, PersistedOAuthCredential>;
  mcpBearer: Record<string, PersistedBearerCredential>;
  [key: string]: unknown;
}

interface MCPServerConfig {
  name: string;
  url: string;
  transport: "http" | "stdio";
  scope: "user" | "project";
  enabled: boolean;
  authType?: "none" | "oauth" | "bearer";
  /** Environment variable read at connection time. Newly configured bearer secrets are never prompted or persisted. */
  bearerTokenEnv?: string;
  token?: string;
  oauthConfig?: OAuthConfig;
  tools?: MCPTool[];
  resources?: MCPResource[];
  lastConnected?: number;
  error?: string;
}

interface MCPConfig {
  servers: Record<string, MCPServerConfig>;
}

interface MCPConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

interface OAuthCallback {
  server: HttpServer;
  result: Promise<string>;
}

class InteractiveAuthorizationRequiredError extends UnauthorizedError {
  constructor() {
    super("Interactive OAuth authorization is required");
  }
}

export function sanitizeTerminalText(
  value: unknown,
  options: { multiline?: boolean; maxLength?: number } = {},
): string {
  const multiline = options.multiline ?? true;
  const maxLength = options.maxLength ?? MAX_REMOTE_TEXT_LENGTH;
  let output = "";
  for (const character of String(value ?? "").normalize("NFC")) {
    const codePoint = character.codePointAt(0)!;
    if (character === "\n" || character === "\r") {
      if (multiline && !output.endsWith("\n")) output += "\n";
      else if (!multiline && output && !output.endsWith(" ")) output += " ";
    } else if (character === "\t") {
      output += multiline ? "  " : " ";
    } else if (
      codePoint < 0x20 ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2060 && codePoint <= 0x206f) ||
      codePoint === 0xfeff
    ) {
      continue;
    } else {
      output += character;
    }
    if (output.length >= maxLength) return `${output.slice(0, maxLength)}…`;
  }
  return output;
}

function getErrorMessage(error: unknown): string {
  const streamableError = error instanceof StreamableHTTPError
    ? error as StreamableHTTPError
    : undefined;
  const message = streamableError?.code
    ? `HTTP ${streamableError.code}: ${streamableError.message}`
    : error instanceof Error ? error.message : String(error);
  return sanitizeTerminalText(message);
}

function isFileMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof UnauthorizedError ||
    (error instanceof StreamableHTTPError && (error as StreamableHTTPError).code === 401);
}

export function isStrictLoopbackUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  if (hostname === "[::1]" || hostname === "::1") return true;
  const octets = hostname.split(".");
  return octets.length === 4 && octets.every(octet => /^\d{1,3}$/.test(octet)) &&
    Number(octets[0]) === 127 && octets.every(octet => Number(octet) <= 255);
}

export function parseSafeHttpUrl(value: string | URL, purpose = "URL"): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.toString()) : new URL(value);
  } catch {
    throw new Error(`${purpose} is not a valid absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${purpose} must use HTTPS (HTTP is allowed only for numeric loopback addresses)`);
  }
  if (url.username || url.password) throw new Error(`${purpose} must not contain userinfo`);
  if (url.hash) throw new Error(`${purpose} must not contain a fragment`);
  if (url.protocol === "http:" && !isStrictLoopbackUrl(url)) {
    throw new Error(`${purpose} must use HTTPS unless it uses a numeric loopback address (127.0.0.0/8 or ::1)`);
  }
  return url;
}

function parseMcpUrl(value: string): URL {
  return parseSafeHttpUrl(value, "MCP endpoint");
}

function validateOAuthDiscoveryState(serverUrl: string, state: OAuthDiscoveryState): void {
  const server = parseMcpUrl(serverUrl);
  const authorizationServer = parseSafeHttpUrl(state.authorizationServerUrl, "OAuth authorization server URL");
  if (state.resourceMetadataUrl) parseSafeHttpUrl(state.resourceMetadataUrl, "OAuth resource metadata URL");
  validateProtectedResourceMetadata(state.resourceMetadata, server);
  validateAuthorizationServerMetadata(state.authorizationServerMetadata, authorizationServer);
}

function validateProtectedResourceMetadata(
  metadata: OAuthProtectedResourceMetadata | undefined,
  serverUrl: URL,
): void {
  if (!metadata) return;
  const resource = parseSafeHttpUrl(metadata.resource, "OAuth protected resource URL");
  if (resource.origin !== serverUrl.origin) {
    throw new Error("OAuth protected resource metadata does not match the MCP endpoint origin");
  }
  for (const value of metadata.authorization_servers ?? []) {
    parseSafeHttpUrl(value, "OAuth authorization server URL");
  }
  for (const key of ["jwks_uri", "resource_documentation", "resource_policy_uri", "resource_tos_uri"] as const) {
    const value = metadata[key];
    if (typeof value === "string" && value) parseSafeHttpUrl(value, `OAuth metadata ${key}`);
  }
}

function validateAuthorizationServerMetadata(
  metadata: AuthorizationServerMetadata | undefined,
  authorizationServerUrl: URL,
): void {
  if (!metadata) return;
  const issuer = parseSafeHttpUrl(metadata.issuer, "OAuth issuer URL");
  const expectedIssuer = new URL(authorizationServerUrl);
  issuer.search = "";
  expectedIssuer.search = "";
  if (issuer.toString().replace(/\/$/, "") !== expectedIssuer.toString().replace(/\/$/, "")) {
    throw new Error("OAuth metadata issuer does not match the discovered authorization server");
  }
  parseSafeHttpUrl(metadata.authorization_endpoint, "OAuth authorization endpoint");
  parseSafeHttpUrl(metadata.token_endpoint, "OAuth token endpoint");
  if (metadata.registration_endpoint) {
    parseSafeHttpUrl(metadata.registration_endpoint, "OAuth registration endpoint");
  }
  if ("userinfo_endpoint" in metadata && typeof metadata.userinfo_endpoint === "string") {
    parseSafeHttpUrl(metadata.userinfo_endpoint, "OpenID userinfo endpoint");
  }
  if ("jwks_uri" in metadata && typeof metadata.jwks_uri === "string") {
    parseSafeHttpUrl(metadata.jwks_uri, "OAuth JWKS URL");
  }
}

const safeFetch: FetchLike = async (input, init = {}) => {
  let url = parseSafeHttpUrl(input, "Outbound MCP/OAuth URL");
  let requestInit: RequestInit = { ...init, redirect: "manual" };
  for (let redirects = 0; ; redirects++) {
    const response = await fetch(url, requestInit);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("HTTP redirect did not include a Location header");
    if (redirects >= MAX_HTTP_REDIRECTS) throw new Error("Too many HTTP redirects");
    const method = String(requestInit.method ?? "GET").toUpperCase();
    const next = parseSafeHttpUrl(new URL(location, url), "HTTP redirect URL");
    if (next.origin !== url.origin) throw new Error("Refusing cross-origin HTTP redirect");
    if (method !== "GET" && method !== "HEAD" && response.status !== 307 && response.status !== 308) {
      throw new Error(`Refusing method-changing HTTP redirect for ${method} request`);
    }
    url = next;
  }
};

export function normalizedMcpToolName(serverName: string, remoteName: string): string {
  return `mcp_${serverName}_${remoteName}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

export function disambiguateToolName(base: string, identity: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 10);
  let candidate = `${base}_${suffix}`;
  let counter = 2;
  while (used.has(candidate)) candidate = `${base}_${suffix}_${counter++}`;
  return candidate;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isFileMissing(error)) return false;
    throw error;
  }
}

async function openBrowser(value: string | URL): Promise<void> {
  const url = parseSafeHttpUrl(value, "Browser authorization URL").toString();
  if (process.platform === "win32") {
    await execFileAsync("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
  } else if (process.platform === "darwin") {
    await execFileAsync("open", [url]);
  } else {
    await execFileAsync("xdg-open", [url]);
  }
}

export default function mcpExtension(pi: ExtensionAPI) {
  const servers = new Map<string, MCPServerConfig>();
  const connections = new Map<string, MCPConnection>();
  const connectionAttempts = new Map<string, Promise<{ tools: number; resources: number }>>();
  const pendingTransports = new Set<StreamableHTTPClientTransport>();
  const registeredToolNames = new Map<string, Set<string>>();
  let shuttingDown = false;
  let userConfigPath = "";
  let projectConfigPath = "";
  let projectConfigEnabled = false;
  let credentialsPath = "";
  let credentials: MCPCredentials = { mcpOAuth: {}, mcpBearer: {} };
  let credentialsWriteQueue: Promise<void> = Promise.resolve();
  let spinnerIndex = 0;
  let renderTicker: ReturnType<typeof setInterval> | undefined;
  const renderInvalidators = new Map<string, () => void>();
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  interface CompactMCPRenderState {
    calledAt?: number;
    startedAt?: number;
    finishedAt?: number;
    progressText?: string;
    callText?: Text;
  }

  interface CompactMCPRenderContext {
    args: Record<string, unknown>;
    toolCallId: string;
    invalidate: () => void;
    lastComponent: unknown;
    state: CompactMCPRenderState;
    executionStarted: boolean;
    isPartial: boolean;
    isError: boolean;
  }

  const formatClock = (timestamp: number) => new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const formatElapsed = (milliseconds: number) => milliseconds < 1000
    ? `${Math.max(0, Math.round(milliseconds))}ms`
    : `${(milliseconds / 1000).toFixed(1)}s`;

  const compactValue = (key: string, value: unknown): string => {
    if (/(?:authorization|token|secret|password|cookie|api[-_]?key|credential|signature)/i.test(key)) {
      return "<redacted>";
    }
    if (typeof value === "string") {
      if (value.length > 160 || /(?:content|text|markdown|json|chunk|body|data)/i.test(key)) {
        return `<${Buffer.byteLength(value, "utf8")} bytes>`;
      }
      return JSON.stringify(sanitizeTerminalText(value, { multiline: false, maxLength: 512 }));
    }
    if (Array.isArray(value)) return `<${value.length} items>`;
    if (value && typeof value === "object") return `<${Object.keys(value as Record<string, unknown>).length} fields>`;
    return JSON.stringify(value);
  };

  const formatMCPArgs = (args: Record<string, unknown>): string => {
    const entries = Object.entries(args ?? {});
    if (entries.length === 0) return "{}";
    return entries.map(([key, value]) =>
      `${sanitizeTerminalText(key, { multiline: false, maxLength: 256 })}=${compactValue(key, value)}`,
    ).join(" ");
  };

  const ensureRenderTicker = () => {
    if (renderTicker) return;
    renderTicker = setInterval(() => {
      spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
      for (const invalidate of renderInvalidators.values()) invalidate();
    }, 100);
    renderTicker.unref?.();
  };

  const stopRenderTickerIfIdle = () => {
    if (renderInvalidators.size !== 0 || !renderTicker) return;
    clearInterval(renderTicker);
    renderTicker = undefined;
  };

  const renderCompactMCPCall = (
    server: MCPServerConfig,
    toolName: string,
    args: Record<string, unknown>,
    theme: any,
    context: CompactMCPRenderContext,
  ) => {
    const state = context.state;
    const now = Date.now();
    state.calledAt ??= now;
    if (context.executionStarted) state.startedAt ??= now;
    if (!context.isPartial) state.finishedAt ??= now;

    if (context.executionStarted && context.isPartial) {
      renderInvalidators.set(context.toolCallId, context.invalidate);
      ensureRenderTicker();
    } else if (!context.isPartial) {
      renderInvalidators.delete(context.toolCallId);
      stopRenderTickerIfIdle();
    }

    const icon = !context.executionStarted
      ? theme.fg("dim", "○")
      : context.isPartial
        ? theme.fg("accent", spinnerFrames[spinnerIndex])
        : context.isError
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
    const timestamp = theme.fg("dim", `[${formatClock(state.calledAt)}]`);
    const label = theme.fg("toolTitle", theme.bold(`mcp ${safeServerName(server)}/${safeToolName(toolName)}`));
    const elapsed = state.startedAt === undefined
      ? ""
      : theme.fg("dim", ` · ${formatElapsed((state.finishedAt ?? now) - state.startedAt)}`);
    const progress = context.isPartial && state.progressText
      ? theme.fg("dim", ` · ${sanitizeTerminalText(state.progressText, { multiline: false, maxLength: 1024 })}`)
      : "";
    const prefix = `${timestamp} ${icon} ${label}${elapsed}${progress}`;
    const formattedArgs = formatMCPArgs(args);
    const lines = formattedArgs.split("\n");
    const indent = " ".repeat(visibleWidth(prefix) + 3);
    let output = `${prefix} · ${lines[0] ?? ""}`;
    for (const line of lines.slice(1)) output += `\n${indent}${line}`;

    let text = state.callText;
    if (!text && context.lastComponent instanceof Text) text = context.lastComponent;
    text ??= new Text("", 0, 0);
    state.callText = text;
    text.setText(output);
    return text;
  };

  function initPaths(cwd: string) {
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    userConfigPath = join(agentDir, "mcp-config.json");
    projectConfigPath = join(cwd, CONFIG_DIR_NAME, "mcp-config.json");
    credentialsPath = join(agentDir, ".credentials.json");
  }

  function credentialKey(server: Pick<MCPServerConfig, "name" | "url">): string {
    const normalizedUrl = normalizeUrlForCredentialKey(server.url);
    const urlHash = createHash("sha256").update(normalizedUrl).digest("hex").slice(0, 16);
    return `${server.name}|${urlHash}`;
  }

  function emptyCredentials(): MCPCredentials {
    return { mcpOAuth: {}, mcpBearer: {} };
  }

  function safeServerName(server: Pick<MCPServerConfig, "name">): string {
    return sanitizeTerminalText(server.name, { multiline: false, maxLength: 256 });
  }

  function safeToolName(toolName: string): string {
    return sanitizeTerminalText(toolName, { multiline: false, maxLength: 512 });
  }

  function normalizeUrlForCredentialKey(url: string): string {
    const parsed = parseMcpUrl(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === "https:" && parsed.port === "443") ||
        (parsed.protocol === "http:" && parsed.port === "80")) {
      parsed.port = "";
    }
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString();
  }

  async function loadCredentials() {
    try {
      const parsed = JSON.parse(await readFile(credentialsPath, "utf8")) as Partial<MCPCredentials>;
      credentials = {
        ...parsed,
        mcpOAuth: parsed.mcpOAuth && typeof parsed.mcpOAuth === "object" ? parsed.mcpOAuth : {},
        mcpBearer: parsed.mcpBearer && typeof parsed.mcpBearer === "object" ? parsed.mcpBearer : {},
      };
      for (const credential of Object.values(credentials.mcpOAuth)) {
        if (!credential || typeof credential !== "object") continue;
        parseMcpUrl(credential.serverUrl);
        if (credential.discoveryState) validateOAuthDiscoveryState(credential.serverUrl, credential.discoveryState);
      }
    } catch (error) {
      if (isFileMissing(error)) {
        credentials = emptyCredentials();
        return;
      }
      throw error;
    }
  }

  function saveCredentials(): Promise<void> {
    const write = credentialsWriteQueue.then(async () => {
      await mkdir(dirname(credentialsPath), { recursive: true });
      await writeFile(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await secureFile(credentialsPath);
    });
    credentialsWriteQueue = write.catch(() => {});
    return write;
  }

  async function migrateLegacyCredentials(): Promise<boolean> {
    let changed = false;
    for (const server of servers.values()) {
      const key = credentialKey(server);
      if (server.authType === "oauth") {
        const legacy = server.oauthConfig;
        if (legacy?.clientInformation || legacy?.tokens || legacy?.codeVerifier) {
          const current = credentials.mcpOAuth[key] ?? {
            serverName: server.name,
            serverUrl: server.url,
          };
          const importedLegacyTokens = !current.tokens && Boolean(legacy.tokens);
          current.clientInformation ??= legacy.clientInformation;
          current.tokens ??= legacy.tokens;
          current.codeVerifier ??= legacy.codeVerifier;
          // expires_in is relative to issuance. A migrated token has no trustworthy
          // issuance timestamp. Mark refresh-token credentials expired so the next
          // connection refreshes them; access-only credentials are tried as-is once.
          if (importedLegacyTokens) {
            current.expiresAt = current.tokens?.refresh_token ? 0 : undefined;
          }
          credentials.mcpOAuth[key] = current;
          delete legacy.clientInformation;
          delete legacy.tokens;
          delete legacy.codeVerifier;
          changed = true;
        }
      } else if (server.authType === "bearer" && server.token) {
        credentials.mcpBearer[key] ??= {
          serverName: server.name,
          serverUrl: server.url,
          token: server.token,
        };
        delete server.token;
        changed = true;
      }
    }
    return changed;
  }

  function validateServerConfig(key: string, server: MCPServerConfig, path: string): MCPServerConfig {
    if (!server || typeof server !== "object") throw new Error(`Invalid MCP server ${key} in ${path}`);
    if (server.name !== key || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) {
      throw new Error(`Invalid MCP server name ${sanitizeTerminalText(key, { multiline: false })} in ${path}`);
    }
    if (server.transport !== "http") throw new Error(`Invalid MCP transport for ${key}: only http is supported`);
    if (server.scope !== "user" && server.scope !== "project") throw new Error(`Invalid MCP scope for ${key}`);
    if (typeof server.enabled !== "boolean") throw new Error(`Invalid enabled value for ${key}`);
    if (server.authType !== undefined && !["none", "oauth", "bearer"].includes(server.authType)) {
      throw new Error(`Invalid MCP auth type for ${key}`);
    }
    parseMcpUrl(server.url);
    if (server.oauthConfig?.authUrl) parseSafeHttpUrl(server.oauthConfig.authUrl, `OAuth authUrl for ${key}`);
    if (server.oauthConfig?.tokenUrl) parseSafeHttpUrl(server.oauthConfig.tokenUrl, `OAuth tokenUrl for ${key}`);
    if (server.oauthConfig?.redirectUri && server.oauthConfig.redirectUri !== OAUTH_CALLBACK_URL) {
      throw new Error(`Unsupported OAuth redirectUri for ${key}; this extension uses its fixed loopback callback`);
    }
    if (server.oauthConfig?.scope && !/^[\x21\x23-\x5B\x5D-\x7E](?:[\x20\x21\x23-\x5B\x5D-\x7E]{0,2047})$/.test(server.oauthConfig.scope)) {
      throw new Error(`Invalid OAuth scope for ${key}`);
    }
    if (server.bearerTokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(server.bearerTokenEnv)) {
      throw new Error(`Invalid bearerTokenEnv for ${key}`);
    }
    return server;
  }

  async function readConfig(path: string): Promise<MCPConfig | undefined> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as MCPConfig;
      if (!parsed || typeof parsed !== "object" || !parsed.servers || typeof parsed.servers !== "object" || Array.isArray(parsed.servers)) {
        throw new Error(`Invalid MCP configuration: ${path}`);
      }
      for (const [key, server] of Object.entries(parsed.servers)) validateServerConfig(key, server, path);
      return parsed;
    } catch (error) {
      if (isFileMissing(error)) return undefined;
      throw error;
    }
  }

  async function loadConfig(includeProjectConfig: boolean) {
    projectConfigEnabled = includeProjectConfig;
    servers.clear();
    const userConfig = await readConfig(userConfigPath);
    for (const [name, server] of Object.entries(userConfig?.servers ?? {})) {
      if (server.scope === "user") servers.set(name, server);
    }

    if (!includeProjectConfig) return;
    const projectConfig = await readConfig(projectConfigPath);
    for (const [name, server] of Object.entries(projectConfig?.servers ?? {})) {
      if (server.scope === "project") servers.set(name, server);
    }
  }

  async function secureFile(path: string) {
    if (process.platform !== "win32") {
      await chmod(path, 0o600);
      return;
    }

    const username = process.env.USERNAME;
    if (!username) throw new Error(`Cannot secure MCP file without USERNAME: ${path}`);
    const identity = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${username}` : username;
    await execFileAsync("icacls.exe", [
      path,
      "/inheritance:r",
      "/grant:r",
      `${identity}:(F)`,
      "*S-1-5-18:(F)",
      "*S-1-5-32-544:(F)",
    ]);
  }

  async function writeConfig(path: string, scopedServers: Record<string, MCPServerConfig>) {
    if (Object.keys(scopedServers).length === 0 && !(await fileExists(path))) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ servers: scopedServers }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await secureFile(path);
  }

  async function saveConfig() {
    const userServers: Record<string, MCPServerConfig> = {};
    const projectServers: Record<string, MCPServerConfig> = {};
    for (const [name, server] of servers) {
      if (server.scope === "user") userServers[name] = server;
      else projectServers[name] = server;
    }

    // Existing files must also be overwritten when their last server is removed.
    await Promise.all([
      writeConfig(userConfigPath, userServers),
      projectConfigEnabled ? writeConfig(projectConfigPath, projectServers) : Promise.resolve(),
    ]);
  }

  async function closeConnection(name: string) {
    const connection = connections.get(name);
    connections.delete(name);
    if (!connection) return;
    try {
      await connection.client.close();
    } catch {
      try {
        await connection.transport.close();
      } catch {
        // The connection may already be closed after an HTTP or auth failure.
      }
    }
  }

  function deactivateServerTools(name: string) {
    const names = registeredToolNames.get(name);
    if (!names?.size) return;
    pi.setActiveTools(pi.getActiveTools().filter(toolName => !names.has(toolName)));
  }

  class PersistentOAuthProvider implements OAuthClientProvider {
    private expectedState?: string;

    constructor(
      private readonly server: MCPServerConfig,
      private readonly ctx: any,
      private readonly interactive: boolean,
    ) {}

    private get key() {
      return credentialKey(this.server);
    }

    private get credential() {
      return credentials.mcpOAuth[this.key];
    }

    private ensureCredential() {
      return credentials.mcpOAuth[this.key] ??= {
        serverName: this.server.name,
        serverUrl: this.server.url,
      };
    }

    get redirectUrl() {
      return OAUTH_CALLBACK_URL;
    }

    get clientMetadata(): OAuthClientMetadata {
      const explicitScope = this.server.oauthConfig?.scope;
      return {
        client_name: "Pi MCP Extension",
        redirect_uris: [OAUTH_CALLBACK_URL],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        // A refresh token is what makes identity survive access-token expiry.
        scope: explicitScope
          ? `${explicitScope} offline_access`.split(/\s+/).filter((value, index, all) => all.indexOf(value) === index).join(" ")
          : undefined,
      };
    }

    state() {
      this.expectedState = randomUUID();
      return this.expectedState;
    }

    validateState(state: string | null): boolean {
      return Boolean(this.expectedState && state === this.expectedState);
    }

    clientInformation() {
      const configured = this.credential?.clientInformation;
      if (configured) return configured;
      const legacyClientId = this.server.oauthConfig?.clientId;
      return legacyClientId ? { client_id: legacyClientId } : undefined;
    }

    async saveClientInformation(clientInformation: OAuthClientInformationMixed) {
      this.ensureCredential().clientInformation = clientInformation;
      await saveCredentials();
    }

    tokens() {
      return this.credential?.tokens;
    }

    async saveTokens(tokens: OAuthTokens) {
      const credential = this.ensureCredential();
      credential.tokens = tokens;
      credential.expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined;
      delete credential.codeVerifier;
      await saveCredentials();
    }

    async redirectToAuthorization(authorizationUrl: URL) {
      if (!this.interactive) throw new InteractiveAuthorizationRequiredError();
        const safeAuthorizationUrl = parseSafeHttpUrl(authorizationUrl, "OAuth authorization endpoint");
      this.ctx.ui.notify(`Opening browser for ${safeServerName(this.server)} authentication`, "info");
      try {
        await openBrowser(safeAuthorizationUrl);
      } catch {
        this.ctx.ui.notify(`Open this URL manually:\n${sanitizeTerminalText(safeAuthorizationUrl)}`, "warning");
      }
    }

    async saveCodeVerifier(codeVerifier: string) {
      this.ensureCredential().codeVerifier = codeVerifier;
      await saveCredentials();
    }

    codeVerifier() {
      const verifier = this.credential?.codeVerifier;
      if (!verifier) throw new Error("OAuth PKCE verifier is missing; restart authentication");
      return verifier;
    }

    discoveryState() {
      const discoveryState = this.credential?.discoveryState;
      if (discoveryState) validateOAuthDiscoveryState(this.server.url, discoveryState);
      return discoveryState;
    }

    async saveDiscoveryState(discoveryState: OAuthDiscoveryState) {
      validateOAuthDiscoveryState(this.server.url, discoveryState);
      this.ensureCredential().discoveryState = discoveryState;
      await saveCredentials();
    }

    async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
      const credential = this.credential;
      if (!credential) return;
      if (scope === "all") {
        delete credentials.mcpOAuth[this.key];
      } else {
        if (scope === "client") delete credential.clientInformation;
        if (scope === "tokens") {
          delete credential.tokens;
          delete credential.expiresAt;
        }
        if (scope === "verifier") delete credential.codeVerifier;
        if (scope === "discovery") delete credential.discoveryState;
      }
      await saveCredentials();
    }
  }

  async function startOAuthCallback(provider: PersistentOAuthProvider): Promise<OAuthCallback> {
    let settled = false;
    let resolveResult!: (code: string) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<string>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const server = createServer((request, response) => {
      try {
        const callbackUrl = new URL(request.url ?? "/", OAUTH_CALLBACK_URL);
        if (callbackUrl.pathname !== OAUTH_CALLBACK_PATH) {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Not found");
          return;
        }

        const error = callbackUrl.searchParams.get("error");
        const code = callbackUrl.searchParams.get("code");
        const state = callbackUrl.searchParams.get("state");
        if (error) throw new Error(`OAuth authorization failed: ${error}`);
        if (!code) throw new Error("OAuth callback did not include an authorization code");
        if (!provider.validateState(state)) throw new Error("OAuth callback state did not match");

        settled = true;
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>Pi MCP</title><p>Authentication complete. You can close this window.</p>");
        resolveResult(code);
      } catch (error) {
        settled = true;
        const message = getErrorMessage(error);
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(message);
        rejectResult(new Error(message));
      }
    });

    server.on("error", error => {
      if (!settled) rejectResult(error);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_HOST, () => {
        server.off("error", onError);
        resolve();
      });
    });

    const timeout = setTimeout(() => {
      if (!settled) rejectResult(new Error("OAuth authentication timed out"));
    }, OAUTH_TIMEOUT_MS);
    timeout.unref();
    result.finally(() => clearTimeout(timeout)).catch(() => {});
    return { server, result };
  }

  function getBearerToken(server: MCPServerConfig): string | undefined {
    const envToken = server.bearerTokenEnv ? process.env[server.bearerTokenEnv] : undefined;
    return envToken?.trim() || credentials.mcpBearer[credentialKey(server)]?.token;
  }

  function getOAuthCredential(server: MCPServerConfig): PersistedOAuthCredential | undefined {
    return credentials.mcpOAuth[credentialKey(server)];
  }

  async function connectRaw(
    server: MCPServerConfig,
    authProvider?: OAuthClientProvider,
  ): Promise<MCPConnection> {
    const headers: Record<string, string> = {};
    const bearerToken = getBearerToken(server);
    if (server.authType === "bearer" && bearerToken) {
      headers.Authorization = `Bearer ${bearerToken}`;
    }
    const transport = new StreamableHTTPClientTransport(parseMcpUrl(server.url), {
      authProvider,
      fetch: safeFetch,
      requestInit: Object.keys(headers).length ? { headers } : undefined,
    });
    const client = new Client({ name: "pi-mcp-extension", version: "2.0.0" });
    pendingTransports.add(transport);
    try {
      await client.connect(transport, { timeout: MCP_REQUEST_TIMEOUT_MS });
      if (shuttingDown) {
        await client.close().catch(() => {});
        throw new Error("MCP connection cancelled during session shutdown");
      }
      return { client, transport };
    } catch (error) {
      try {
        await transport.close();
      } catch {
        // Ignore cleanup errors and preserve the original connection error.
      }
      throw error;
    } finally {
      pendingTransports.delete(transport);
    }
  }

  async function getOAuthScope(server: MCPServerConfig): Promise<string> {
    const configured = server.oauthConfig?.scope?.trim();
    if (configured) {
      return `${configured} offline_access`.split(/\s+/).filter((value, index, all) => all.indexOf(value) === index).join(" ");
    }
    try {
      const discovered = await discoverOAuthServerInfo(server.url, { fetchFn: safeFetch });
      const authorizationServer = parseSafeHttpUrl(discovered.authorizationServerUrl, "OAuth authorization server URL");
      validateProtectedResourceMetadata(discovered.resourceMetadata, parseMcpUrl(server.url));
      validateAuthorizationServerMetadata(discovered.authorizationServerMetadata, authorizationServer);
      const scopes = discovered.resourceMetadata?.scopes_supported ?? [];
      return [...new Set([...scopes, "offline_access"])].join(" ");
    } catch {
      return "offline_access";
    }
  }

  async function connectWithOAuth(
    server: MCPServerConfig,
    ctx: any,
    allowInteractive: boolean,
  ): Promise<MCPConnection> {
    server.oauthConfig ??= {};
    const credential = getOAuthCredential(server);

    if (credential?.tokens) {
      const nonInteractiveProvider = new PersistentOAuthProvider(server, ctx, false);
      try {
        if (credential.expiresAt && credential.expiresAt <= Date.now() + 30_000) {
          if (!credential.tokens.refresh_token) throw new InteractiveAuthorizationRequiredError();
          const refreshResult = await auth(nonInteractiveProvider, {
            serverUrl: server.url,
            scope: await getOAuthScope(server),
            fetchFn: safeFetch,
          });
          if (refreshResult !== "AUTHORIZED") throw new InteractiveAuthorizationRequiredError();
        }
        return await connectRaw(server, nonInteractiveProvider);
      } catch (error) {
        if (!(error instanceof InteractiveAuthorizationRequiredError) && !isUnauthorized(error)) throw error;
        if (!allowInteractive) throw new InteractiveAuthorizationRequiredError();
      }
    } else if (!allowInteractive) {
      throw new InteractiveAuthorizationRequiredError();
    }

    const provider = new PersistentOAuthProvider(server, ctx, true);
    const callback = await startOAuthCallback(provider).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw new Error(`OAuth callback port ${OAUTH_CALLBACK_PORT} is already in use`);
      }
      throw error;
    });
    let callbackClosed = false;
    const closeCallback = async () => {
      if (callbackClosed) return;
      callbackClosed = true;
      await new Promise<void>(resolve => callback.server.close(() => resolve()));
    };

    try {
      const scope = await getOAuthScope(server);
      const result = await auth(provider, { serverUrl: server.url, scope, fetchFn: safeFetch });
      if (result !== "REDIRECT") {
        await closeCallback();
        return await connectRaw(server, provider);
      }
      const authorizationCode = await callback.result;
      const finishResult = await auth(provider, {
        serverUrl: server.url,
        authorizationCode,
        scope,
        fetchFn: safeFetch,
      });
      if (finishResult !== "AUTHORIZED") throw new UnauthorizedError("Failed to authorize");
      await closeCallback();
      return await connectRaw(server, provider);
    } finally {
      await closeCallback();
    }
  }

  async function createConnection(
    server: MCPServerConfig,
    ctx: any,
    allowInteractive: boolean,
  ): Promise<MCPConnection> {
    if (server.transport !== "http") throw new Error("Only Streamable HTTP transport is supported");
    if (server.authType === "bearer" && !getBearerToken(server)) {
      const hint = server.bearerTokenEnv ? `Set ${server.bearerTokenEnv} and reconnect` : "Configure --bearer-token-env and reconnect";
      throw new Error(`Bearer token missing. ${hint}`);
    }
    if (server.authType === "oauth") return connectWithOAuth(server, ctx, allowInteractive);
    return connectRaw(server);
  }

  async function listAllTools(client: Client): Promise<MCPTool[]> {
    const tools: MCPTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let pages = 0; ; pages++) {
      if (pages >= MAX_DISCOVERY_PAGES) throw new Error(`MCP tool discovery exceeded ${MAX_DISCOVERY_PAGES} pages`);
      const page = await client.listTools(
        cursor ? { cursor } : undefined,
        { timeout: MCP_REQUEST_TIMEOUT_MS },
      );
      tools.push(...(page.tools as MCPTool[]));
      if (tools.length > MAX_DISCOVERY_ITEMS) throw new Error(`MCP tool discovery exceeded ${MAX_DISCOVERY_ITEMS} items`);
      cursor = page.nextCursor;
      if (!cursor) return tools;
      if (cursors.has(cursor)) throw new Error("MCP tool discovery returned a repeated pagination cursor");
      cursors.add(cursor);
    }
  }

  async function listAllResources(client: Client): Promise<MCPResource[]> {
    if (!client.getServerCapabilities()?.resources) return [];
    const resources: MCPResource[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let pages = 0; ; pages++) {
      if (pages >= MAX_DISCOVERY_PAGES) throw new Error(`MCP resource discovery exceeded ${MAX_DISCOVERY_PAGES} pages`);
      const page = await client.listResources(
        cursor ? { cursor } : undefined,
        { timeout: MCP_REQUEST_TIMEOUT_MS },
      );
      resources.push(...page.resources);
      if (resources.length > MAX_DISCOVERY_ITEMS) throw new Error(`MCP resource discovery exceeded ${MAX_DISCOVERY_ITEMS} items`);
      cursor = page.nextCursor;
      if (!cursor) return resources;
      if (cursors.has(cursor)) throw new Error("MCP resource discovery returned a repeated pagination cursor");
      cursors.add(cursor);
    }
  }

  function schemaToTypeBox(schema: any, required = true): any {
    const options = schema?.description ? { description: sanitizeTerminalText(schema.description) } : {};
    let converted: any;
    if (Array.isArray(schema?.enum) && schema.enum.length > 0) {
      converted = Type.Union(schema.enum.map((value: any) => Type.Literal(value)), options);
    } else {
      switch (schema?.type) {
        case "string":
          converted = Type.String(options);
          break;
        case "number":
          converted = Type.Number(options);
          break;
        case "integer":
          converted = Type.Integer(options);
          break;
        case "boolean":
          converted = Type.Boolean(options);
          break;
        case "array":
          converted = Type.Array(schema.items ? schemaToTypeBox(schema.items) : Type.Any(), options);
          break;
        case "object": {
          const requiredProperties = new Set<string>(schema.required ?? []);
          const properties: Record<string, any> = {};
          for (const [key, property] of Object.entries(schema.properties ?? {})) {
            properties[key] = schemaToTypeBox(property, requiredProperties.has(key));
          }
          converted = Type.Object(properties, options);
          break;
        }
        default:
          converted = Type.Any(options);
      }
    }
    return required ? converted : Type.Optional(converted);
  }

  async function getConnection(name: string, ctx: any): Promise<MCPConnection> {
    let connection = connections.get(name);
    if (connection) return connection;

    const server = servers.get(name);
    if (!server?.enabled) throw new Error(`MCP server ${name} is not enabled`);

    const pending = connectionAttempts.get(name);
    if (pending) await pending;
    else await connectToServer(server, ctx, false);

    connection = connections.get(name);
    if (!connection) throw new Error(`MCP server ${name} is not connected`);
    return connection;
  }

  function truncateRemoteOutput(value: string): string {
    const truncated = truncateHead(sanitizeTerminalText(value, { maxLength: DEFAULT_MAX_BYTES * 4 }), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
    return truncated.truncated
      ? `${truncated.content}\n\n[MCP output truncated: ${truncated.outputBytes} of ${truncated.totalBytes} bytes.]`
      : truncated.content;
  }

  function formatToolResult(result: any): string {
    const lines: string[] = [];
    for (const item of result.content ?? []) {
      if (item.type === "text") lines.push(item.text);
      else if (item.type === "image") lines.push(`[Image: ${sanitizeTerminalText(item.mimeType, { multiline: false })}]`);
      else if (item.type === "audio") lines.push(`[Audio: ${sanitizeTerminalText(item.mimeType, { multiline: false })}]`);
      else if (item.type === "resource") {
        lines.push(item.resource?.text ?? `[Resource: ${sanitizeTerminalText(item.resource?.uri ?? "unknown", { multiline: false })}]`);
      } else if (item.type === "resource_link") {
        lines.push(`[Resource: ${sanitizeTerminalText(item.uri, { multiline: false })}]`);
      }
    }
    if (result.structuredContent) lines.push(JSON.stringify(result.structuredContent, null, 2));
    return truncateRemoteOutput(lines.join("\n") || "MCP tool returned no content");
  }

  function registerServerTools(server: MCPServerConfig) {
    if (!server.enabled) return;
    deactivateServerTools(server.name);
    const names = new Set<string>();
    const usedNames = new Set(pi.getAllTools().map(tool => tool.name));
    for (const name of registeredToolNames.get(server.name) ?? []) usedNames.delete(name);
    const allocateName = (remoteName: string, kind: "tool" | "resource") => {
      const base = normalizedMcpToolName(server.name, remoteName);
      const registeredName = disambiguateToolName(base, `${server.name}\0${kind}\0${remoteName}`, usedNames);
      usedNames.add(registeredName);
      names.add(registeredName);
      return registeredName;
    };

    for (const tool of server.tools ?? []) {
      const registeredName = allocateName(tool.name, "tool");
      const displayServerName = safeServerName(server);
      const displayToolName = safeToolName(tool.name);
      pi.registerTool({
        name: registeredName,
        label: `${displayServerName}: ${displayToolName}`,
        description: sanitizeTerminalText(tool.description || `MCP tool ${displayToolName}`),
        parameters: schemaToTypeBox(tool.inputSchema),
        renderShell: "self",
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          if (!server.enabled) throw new Error(`MCP server ${server.name} is disabled`);
          onUpdate?.({
            content: [{ type: "text", text: `Calling ${displayToolName}...` }],
            details: { server: displayServerName, tool: displayToolName },
          });
          try {
            const connection = await getConnection(server.name, ctx);
            const result = await connection.client.callTool(
              { name: tool.name, arguments: params as Record<string, unknown> },
              undefined,
              {
                signal,
                resetTimeoutOnProgress: true,
                onprogress: progress => {
                  const percent = progress.total && progress.total > 0
                    ? ` ${Math.round(progress.progress / progress.total * 100)}%`
                    : "";
                  const progressMessage = sanitizeTerminalText(progress.message ?? `Calling ${displayToolName}`, {
                    multiline: false,
                    maxLength: 1024,
                  });
                  const safeProgress = {
                    progress: Number.isFinite(progress.progress) ? progress.progress : 0,
                    total: Number.isFinite(progress.total) ? progress.total : undefined,
                    message: progressMessage,
                  };
                  onUpdate?.({
                    content: [{ type: "text", text: `${progressMessage}...${percent}` }],
                    details: { server: displayServerName, tool: displayToolName, progress: safeProgress },
                  });
                },
              },
            );
            if ("isError" in result && result.isError) throw new Error(formatToolResult(result));
            return {
              content: [{ type: "text", text: formatToolResult(result) }],
              details: { server: displayServerName, tool: displayToolName, scope: server.scope },
            };
          } catch (error) {
            throw new Error(getErrorMessage(error));
          }
        },
        renderCall(args, theme, context) {
          return renderCompactMCPCall(server, displayToolName, args as Record<string, unknown>, theme, context as unknown as CompactMCPRenderContext);
        },
        renderResult(result, options, theme, context) {
          const progress = (result.details as any)?.progress;
          if (options.isPartial && progress) {
            const percent = progress.total && progress.total > 0
              ? `${Math.round(progress.progress / progress.total * 100)}%`
              : `${progress.progress}`;
            const progressMessage = progress.message
              ? sanitizeTerminalText(progress.message, { multiline: false, maxLength: 1024 })
              : "";
            context.state.progressText = progressMessage ? `${percent} ${progressMessage}` : percent;
          }
          renderCompactMCPCall(server, displayToolName, context.args as Record<string, unknown>, theme, context as unknown as CompactMCPRenderContext);
          return new Text("", 0, 0);
        },
      });
    }

    if ((server.resources?.length ?? 0) > 0) {
      const registeredName = allocateName("read_resource", "resource");
      const displayServerName = safeServerName(server);
      const resourceUris = server.resources!.map(resource => sanitizeTerminalText(resource.uri, {
        multiline: false,
        maxLength: 1024,
      }));
      pi.registerTool({
        name: registeredName,
        label: `${displayServerName}: Read Resource`,
        description: `Read an MCP resource from ${displayServerName}`,
        parameters: Type.Object({
          uri: Type.String({
            description: sanitizeTerminalText(`Resource URI. Available: ${resourceUris.join(", ")}`),
          }),
        }),
        renderShell: "self",
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          if (!server.enabled) throw new Error(`MCP server ${server.name} is disabled`);
          const displayUri = sanitizeTerminalText(params.uri, { multiline: false, maxLength: 2048 });
          onUpdate?.({
            content: [{ type: "text", text: `Reading ${displayUri}...` }],
            details: { server: displayServerName, uri: displayUri },
          });
          try {
            const connection = await getConnection(server.name, ctx);
            const result = await connection.client.readResource({ uri: params.uri }, { signal });
            const content = result.contents.map(item =>
              "text" in item ? item.text : `[Binary resource: ${sanitizeTerminalText(item.mimeType ?? "unknown", { multiline: false })}]`,
            );
            return {
              content: [{ type: "text", text: truncateRemoteOutput(content.join("\n")) }],
              details: { server: displayServerName, uri: displayUri, scope: server.scope },
            };
          } catch (error) {
            throw new Error(getErrorMessage(error));
          }
        },
        renderCall(args, theme, context) {
          return renderCompactMCPCall(server, "read_resource", args as Record<string, unknown>, theme, context as unknown as CompactMCPRenderContext);
        },
        renderResult(_result, _options, theme, context) {
          renderCompactMCPCall(server, "read_resource", context.args as Record<string, unknown>, theme, context as unknown as CompactMCPRenderContext);
          return new Text("", 0, 0);
        },
      });
    }

    registeredToolNames.set(server.name, names);
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
  }

  async function connectToServer(server: MCPServerConfig, ctx: any, allowAuthPrompt = true) {
    await closeConnection(server.name);
    ctx.ui.notify(`Connecting to ${safeServerName(server)} (${server.scope})...`, "info");

    try {
      let connection: MCPConnection;
      const hasOAuthToken = Boolean(getOAuthCredential(server)?.tokens);
      if (server.authType === "oauth" && !hasOAuthToken) {
        if (!allowAuthPrompt || !ctx.hasUI) {
          throw new Error(`Authentication required. Run /mcp auth ${safeServerName(server)}`);
        }
        const authenticate = await ctx.ui.confirm(
          "MCP authentication required",
          `Open the browser to authenticate ${safeServerName(server)}?`,
        );
        if (!authenticate) throw new Error(`Authentication required. Run /mcp auth ${safeServerName(server)}`);
      }

      try {
        connection = await createConnection(server, ctx, allowAuthPrompt && ctx.hasUI);
      } catch (error) {
        if (!(error instanceof InteractiveAuthorizationRequiredError) &&
            (!isUnauthorized(error) || server.authType === "bearer")) throw error;
        if (!allowAuthPrompt || !ctx.hasUI) {
          throw new Error(`Authentication required. Run /mcp auth ${safeServerName(server)}`);
        }
        const authenticate = await ctx.ui.confirm(
          "MCP authentication required",
          `Open the browser to authenticate ${safeServerName(server)}?`,
        );
        if (!authenticate) throw new Error(`Authentication required. Run /mcp auth ${safeServerName(server)}`);
        server.authType = "oauth";
        server.oauthConfig ??= {};
        await saveConfig();
        connection = await createConnection(server, ctx, true);
      }

      connections.set(server.name, connection);
      const tools = await listAllTools(connection.client);
      const resources = await listAllResources(connection.client);
      if (shuttingDown) {
        await closeConnection(server.name);
        throw new Error("MCP connection cancelled during session shutdown");
      }
      server.tools = tools;
      server.resources = resources;
      server.lastConnected = Date.now();
      delete server.error;
      registerServerTools(server);
      await saveConfig();
      return { tools: tools.length, resources: resources.length };
    } catch (error) {
      const message = getErrorMessage(error);
      await closeConnection(server.name);
      if (!shuttingDown) {
        server.error = message;
        await saveConfig();
      }
      throw new Error(message);
    }
  }

  function connectInBackground(server: MCPServerConfig, ctx: any) {
    const existing = connectionAttempts.get(server.name);
    if (existing) return existing;

    const startedAt = Date.now();
    const attempt = connectToServer(server, ctx, false);
    connectionAttempts.set(server.name, attempt);
    void attempt.then(result => {
      if (!shuttingDown) {
        ctx.ui.notify(
          `${safeServerName(server)}: ${result.tools} tools, ${result.resources} resources (${Date.now() - startedAt} ms)`,
          "info",
        );
      }
    }).catch(error => {
      if (!shuttingDown) ctx.ui.notify(`${safeServerName(server)}: ${getErrorMessage(error)}`, "error");
    }).finally(() => {
      if (connectionAttempts.get(server.name) === attempt) connectionAttempts.delete(server.name);
    });
    return attempt;
  }

  pi.on("session_start", async (_event, ctx) => {
    shuttingDown = false;
    initPaths(ctx.cwd);
    await Promise.all([loadConfig(ctx.isProjectTrusted()), loadCredentials()]);
    if (await migrateLegacyCredentials()) {
      await Promise.all([saveConfig(), saveCredentials()]);
    }
    const enabledServers = [...servers.values()].filter(server => server.enabled);
    if (enabledServers.length === 0) {
      ctx.ui.notify("MCP extension loaded. Use /mcp to manage servers.", "info");
      return;
    }

    let cachedToolCount = 0;
    for (const server of enabledServers) {
      if ((server.tools?.length ?? 0) > 0 || (server.resources?.length ?? 0) > 0) {
        registerServerTools(server);
        cachedToolCount += server.tools?.length ?? 0;
      }
      connectInBackground(server, ctx);
    }
    ctx.ui.notify(
      `MCP: restored ${cachedToolCount} cached tool(s); reconnecting ${enabledServers.length} server(s) in background`,
      "info",
    );
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    if (renderTicker) clearInterval(renderTicker);
    renderTicker = undefined;
    renderInvalidators.clear();
    await Promise.all([
      ...[...connections.keys()].map(name => closeConnection(name)),
      ...[...pendingTransports].map(transport => transport.close().catch(() => {})),
    ]);
    pendingTransports.clear();
    connectionAttempts.clear();
  });

  pi.registerCommand("mcp", {
    description: "Manage MCP servers",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.includes("--token")) {
        ctx.ui.notify("Do not place bearer tokens in command text. Use --bearer-token-env <ENV_VAR>.", "error");
        return;
      }
      const command = parts[0] || "list";
      if (command === "add") await handleAdd(parts, ctx);
      else if (command === "remove") await handleRemove(parts, ctx);
      else if (command === "enable") await handleEnable(parts, ctx);
      else if (command === "disable") await handleDisable(parts, ctx);
      else if (command === "connect") await handleConnect(parts, ctx);
      else if (command === "auth") await handleAuth(parts, ctx);
      else if (command === "list") displayServers(ctx, parts.includes("--details"));
      else displayHelp(ctx);
    },
  });

  function displayHelp(ctx: any) {
    ctx.ui.notify(
      "MCP commands:\n" +
      "  /mcp list [--details]\n" +
      "  /mcp add --transport http --scope <user|project> <name> <url> [--auth <none|oauth|bearer>] [--bearer-token-env <ENV_VAR>]\n" +
      "  /mcp remove <name>\n" +
      "  /mcp enable|disable <name>\n" +
      "  /mcp connect <name>\n" +
      "  /mcp auth <name>",
      "info",
    );
  }

  function displayServers(ctx: any, details: boolean) {
    if (servers.size === 0) {
      ctx.ui.notify("No MCP servers configured", "info");
      return;
    }
    const lines: string[] = [];
    for (const scope of ["user", "project"] as const) {
      const scoped = [...servers.values()].filter(server => server.scope === scope);
      if (!scoped.length) continue;
      lines.push(`${scope.toUpperCase()} (${scoped.length})`);
      if (details) lines.push(`Config: ${scope === "user" ? userConfigPath : projectConfigPath}`);
      for (const server of scoped) {
        const state = server.enabled ? "enabled" : "disabled";
        const connected = connections.has(server.name) ? "connected" : "disconnected";
        lines.push(`  ${safeServerName(server)}: ${sanitizeTerminalText(server.url, { multiline: false })} [${state}, ${connected}, ${server.authType ?? "none"}]`);
        lines.push(`    ${(server.tools?.length ?? 0)} tools, ${(server.resources?.length ?? 0)} resources${server.error ? `; ${sanitizeTerminalText(server.error)}` : ""}`);
      }
    }
    ctx.ui.notify(lines.join("\n"), "info");
  }

  async function handleAdd(parts: string[], ctx: any) {
    let transport: "http" | "stdio" | undefined;
    let scope: "user" | "project" | undefined;
    let authType: "none" | "oauth" | "bearer" = "none";
    let oauthScope: string | undefined;
    let bearerTokenEnv: string | undefined;
    const positional: string[] = [];
    let parseError: string | undefined;

    for (let index = 1; index < parts.length; index++) {
      const part = parts[index];
      if (["--transport", "--scope", "--auth", "--oauth-scope", "--bearer-token-env"].includes(part)) {
        const value = parts[++index];
        if (!value) {
          parseError = `Missing value for ${part}`;
          break;
        }
        if (part === "--transport") transport = value as "http" | "stdio";
        else if (part === "--scope") scope = value as "user" | "project";
        else if (part === "--auth") authType = value as "none" | "oauth" | "bearer";
        else if (part === "--oauth-scope") oauthScope = value;
        else bearerTokenEnv = value;
      } else if (part.startsWith("--")) {
        parseError = `Unknown option: ${part}`;
        break;
      } else positional.push(part);
    }

    const [name, url, ...extra] = positional;
    const validAuthType = ["none", "oauth", "bearer"].includes(authType);
    const validEnv = !bearerTokenEnv || /^[A-Za-z_][A-Za-z0-9_]*$/.test(bearerTokenEnv);
    const validOAuthScope = !oauthScope || /^[\x21\x23-\x5B\x5D-\x7E]{1,2048}$/.test(oauthScope);
    if (parseError || transport !== "http" || !["user", "project"].includes(scope ?? "") || !validAuthType ||
        !validEnv || !validOAuthScope || !name || !url || extra.length > 0 || (bearerTokenEnv && authType !== "bearer") ||
        (authType === "bearer" && !bearerTokenEnv) || (oauthScope && authType !== "oauth")) {
      ctx.ui.notify(
        `${parseError ? `${parseError}\n` : ""}Usage: /mcp add --transport http --scope <user|project> <name> <url> ` +
        "[--auth <none|oauth|bearer>] [--oauth-scope <scope>] [--bearer-token-env <ENV_VAR>]",
        "error",
      );
      return;
    }
    try {
      parseMcpUrl(url);
    } catch (error) {
      ctx.ui.notify(`Invalid MCP URL: ${getErrorMessage(error)}`, "error");
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
      ctx.ui.notify("MCP server names must be 1-128 characters using letters, numbers, dot, underscore, or hyphen", "error");
      return;
    }
    if (servers.has(name)) {
      ctx.ui.notify(`MCP server \"${sanitizeTerminalText(name, { multiline: false })}\" already exists`, "error");
      return;
    }

    if (scope === "project" && !ctx.isProjectTrusted()) {
      ctx.ui.notify("Project-scoped MCP servers require a trusted project", "error");
      return;
    }

    const server: MCPServerConfig = {
      name,
      url,
      transport,
      scope: scope!,
      enabled: true,
      authType,
      bearerTokenEnv,
      oauthConfig: authType === "oauth" ? { scope: oauthScope } : undefined,
    };
    servers.set(name, server);
    await Promise.all([saveConfig(), saveCredentials()]);
    try {
      const result = await connectToServer(server, ctx);
      ctx.ui.notify(`Added ${safeServerName(server)}: ${result.tools} tools, ${result.resources} resources`, "info");
    } catch (error) {
      ctx.ui.notify(`Added ${safeServerName(server)}, but connection failed: ${getErrorMessage(error)}`, "warning");
    }
  }

  async function handleRemove(parts: string[], ctx: any) {
    const name = parts[1];
    const server = name ? servers.get(name) : undefined;
    if (!server) {
      ctx.ui.notify(name ? `MCP server \"${name}\" not found` : "Usage: /mcp remove <name>", "error");
      return;
    }
    server.enabled = false;
    deactivateServerTools(name);
    await closeConnection(name);
    delete credentials.mcpOAuth[credentialKey(server)];
    delete credentials.mcpBearer[credentialKey(server)];
    servers.delete(name);
    await Promise.all([saveConfig(), saveCredentials()]);
    ctx.ui.notify(`Removed ${name} from ${server.scope} scope`, "info");
  }

  async function handleEnable(parts: string[], ctx: any) {
    const server = parts[1] ? servers.get(parts[1]) : undefined;
    if (!server) {
      ctx.ui.notify("Usage: /mcp enable <name>", "error");
      return;
    }
    server.enabled = true;
    await saveConfig();
    try {
      const result = await connectToServer(server, ctx);
      ctx.ui.notify(`Enabled ${safeServerName(server)}: ${result.tools} tools, ${result.resources} resources`, "info");
    } catch (error) {
      ctx.ui.notify(`Enabled ${safeServerName(server)}, but connection failed: ${getErrorMessage(error)}`, "warning");
    }
  }

  async function handleDisable(parts: string[], ctx: any) {
    const server = parts[1] ? servers.get(parts[1]) : undefined;
    if (!server) {
      ctx.ui.notify("Usage: /mcp disable <name>", "error");
      return;
    }
    server.enabled = false;
    deactivateServerTools(server.name);
    await closeConnection(server.name);
    await saveConfig();
    ctx.ui.notify(`Disabled ${safeServerName(server)}`, "info");
  }

  async function handleConnect(parts: string[], ctx: any) {
    const server = parts[1] ? servers.get(parts[1]) : undefined;
    if (!server) {
      ctx.ui.notify("Usage: /mcp connect <name>", "error");
      return;
    }
    try {
      const result = await connectToServer(server, ctx);
      ctx.ui.notify(`Connected ${safeServerName(server)}: ${result.tools} tools, ${result.resources} resources`, "info");
    } catch (error) {
      ctx.ui.notify(`Connection failed: ${getErrorMessage(error)}`, "error");
    }
  }

  async function handleAuth(parts: string[], ctx: any) {
    const server = parts[1] ? servers.get(parts[1]) : undefined;
    if (!server) {
      ctx.ui.notify("Usage: /mcp auth <name>", "error");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("MCP authentication requires an interactive UI", "error");
      return;
    }

    if (server.authType === "bearer") {
      ctx.ui.notify(
        server.bearerTokenEnv
          ? `Bearer credentials are read from ${server.bearerTokenEnv}. Set it in Pi's environment, then run /mcp connect ${safeServerName(server)}.`
          : "Pi 0.82.1 exposes no supported masked secret input to ordinary extensions. Re-add this server with --bearer-token-env <ENV_VAR>; ordinary ui.input is intentionally not used.",
        "warning",
      );
      return;
    } else {
      server.authType = "oauth";
      server.oauthConfig ??= {};
      delete credentials.mcpOAuth[credentialKey(server)];
      delete credentials.mcpBearer[credentialKey(server)];
      delete server.oauthConfig.tokens;
      delete server.oauthConfig.codeVerifier;
      delete server.token;
    }
    await Promise.all([saveConfig(), saveCredentials()]);

    try {
      const result = await connectToServer(server, ctx);
      ctx.ui.notify(`Authenticated ${safeServerName(server)}: ${result.tools} tools, ${result.resources} resources`, "info");
    } catch (error) {
      ctx.ui.notify(`Authentication failed: ${getErrorMessage(error)}`, "error");
    }
  }

  pi.registerCommand("mcp-test", {
    description: "Test a Streamable HTTP MCP endpoint",
    handler: async (args, ctx) => {
      const url = args.trim();
      if (!url) {
        ctx.ui.notify("Usage: /mcp-test <url>", "error");
        return;
      }
      try {
        parseMcpUrl(url);
      } catch (error) {
        ctx.ui.notify(`Invalid MCP URL: ${getErrorMessage(error)}`, "error");
        return;
      }
      const testServer: MCPServerConfig = {
        name: "test",
        url,
        transport: "http",
        scope: "user",
        enabled: true,
        authType: "none",
      };
      try {
        const connection = await connectRaw(testServer);
        try {
          const tools = await listAllTools(connection.client);
          const resources = await listAllResources(connection.client);
          ctx.ui.notify(`Valid MCP endpoint: ${tools.length} tools, ${resources.length} resources`, "info");
        } finally {
          await connection.client.close().catch(() => {});
        }
      } catch (error) {
        if (isUnauthorized(error)) {
          ctx.ui.notify("Valid MCP endpoint; authentication is required", "warning");
        } else {
          ctx.ui.notify(`MCP test failed: ${getErrorMessage(error)}`, "error");
        }
      }
    },
  });
}
