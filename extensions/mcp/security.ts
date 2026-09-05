import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const OAUTH_CALLBACK_HOST = "127.0.0.1";
export const OAUTH_CALLBACK_PORT = 33418;
export const OAUTH_CALLBACK_PATH = "/oauth/callback";
export const OAUTH_CALLBACK_URL = `http://${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;
export const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_DISCOVERY_PAGES = 100;
export const MAX_DISCOVERY_ITEMS = 10_000;
export const MAX_HTTP_REDIRECTS = 5;
export const MAX_REMOTE_TEXT_LENGTH = 16_384;
export const CLIENT_NAME = "pi-mcp-extension";
export const CLIENT_VERSION = "2.0.0";

const parsedRequestTimeout = Number(process.env.PI_MCP_REQUEST_TIMEOUT_MS ?? 15_000);
export const MCP_REQUEST_TIMEOUT_MS = Number.isFinite(parsedRequestTimeout) && parsedRequestTimeout > 0
  ? parsedRequestTimeout
  : 15_000;

const execFileAsync = promisify(execFile);

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

export function getErrorMessage(error: unknown): string {
  const streamableError = error instanceof StreamableHTTPError ? error : undefined;
  const message = streamableError?.code
    ? `HTTP ${streamableError.code}: ${streamableError.message}`
    : error instanceof Error ? error.message : String(error);
  return sanitizeTerminalText(message);
}

export function isFileMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof UnauthorizedError ||
    (error instanceof StreamableHTTPError && error.code === 401);
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

export function parseMcpUrl(value: string): URL {
  return parseSafeHttpUrl(value, "MCP endpoint");
}

export function validateProtectedResourceMetadata(
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

export function validateAuthorizationServerMetadata(
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
  if (metadata.registration_endpoint) parseSafeHttpUrl(metadata.registration_endpoint, "OAuth registration endpoint");
  if ("userinfo_endpoint" in metadata && typeof metadata.userinfo_endpoint === "string") {
    parseSafeHttpUrl(metadata.userinfo_endpoint, "OpenID userinfo endpoint");
  }
  if ("jwks_uri" in metadata && typeof metadata.jwks_uri === "string") {
    parseSafeHttpUrl(metadata.jwks_uri, "OAuth JWKS URL");
  }
}

export const safeFetch: FetchLike = async (input, init = {}) => {
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

export async function openBrowser(value: string | URL): Promise<void> {
  const url = parseSafeHttpUrl(value, "Browser authorization URL").toString();
  if (process.platform === "win32") await execFileAsync("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
  else if (process.platform === "darwin") await execFileAsync("open", [url]);
  else await execFileAsync("xdg-open", [url]);
}

export function safeServerName(server: { name: string }): string {
  return sanitizeTerminalText(server.name, { multiline: false, maxLength: 256 });
}

export function safeToolName(toolName: string): string {
  return sanitizeTerminalText(toolName, { multiline: false, maxLength: 512 });
}
