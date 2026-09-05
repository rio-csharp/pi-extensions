import {
  auth,
  discoverOAuthServerInfo,
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { MCPConnection, MCPServerConfig, OAuthCallback, McpUiContext } from "./types.js";
import {
  OAUTH_CALLBACK_HOST,
  OAUTH_CALLBACK_PATH,
  OAUTH_CALLBACK_PORT,
  OAUTH_CALLBACK_URL,
  OAUTH_TIMEOUT_MS,
} from "./security.js";
import {
  getErrorMessage,
  isUnauthorized,
  openBrowser,
  parseMcpUrl,
  parseSafeHttpUrl,
  safeFetch,
  sanitizeTerminalText,
  validateAuthorizationServerMetadata,
  validateProtectedResourceMetadata,
} from "./security.js";
import { McpConfigStore } from "./config-store.js";

export class InteractiveAuthorizationRequiredError extends UnauthorizedError {
  constructor() {
    super("Interactive OAuth authorization is required");
  }
}

class PersistentOAuthProvider implements OAuthClientProvider {
  private expectedState?: string;

  private pendingCodeVerifier?: string;

  constructor(
    private readonly server: MCPServerConfig,
    private readonly store: McpConfigStore,
    private readonly ctx: McpUiContext,
    private readonly interactive: boolean,
  ) {}

  private get key() {
    return this.store.credentialKey(this.server);
  }

  private get credential() {
    return this.store.credentials.mcpOAuth[this.key];
  }

  private ensureCredential() {
    return this.store.credentials.mcpOAuth[this.key] ??= {};
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
    return this.credential?.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed) {
    this.ensureCredential().clientInformation = clientInformation;
    await this.store.saveCredentials();
  }

  tokens() {
    return this.credential?.tokens;
  }

  async saveTokens(tokens: OAuthTokens) {
    const credential = this.ensureCredential();
    credential.tokens = tokens;
    credential.expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined;
    this.pendingCodeVerifier = undefined;
    await this.store.saveCredentials();
  }

  async redirectToAuthorization(authorizationUrl: URL) {
    if (!this.interactive) throw new InteractiveAuthorizationRequiredError();
    const safeAuthorizationUrl = parseSafeHttpUrl(authorizationUrl, "OAuth authorization endpoint");
    this.ctx.ui.notify(`Opening browser for ${sanitizeTerminalText(this.server.name, { multiline: false, maxLength: 256 })} authentication`, "info");
    try {
      await openBrowser(safeAuthorizationUrl);
    } catch {
      this.ctx.ui.notify(`Open this URL manually:\n${sanitizeTerminalText(safeAuthorizationUrl)}`, "warning");
    }
  }

  saveCodeVerifier(codeVerifier: string) {
    this.pendingCodeVerifier = codeVerifier;
  }

  codeVerifier() {
    const verifier = this.pendingCodeVerifier;
    if (!verifier) throw new Error("OAuth PKCE verifier is missing; restart authentication");
    return verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "verifier") {
      this.pendingCodeVerifier = undefined;
      return;
    }
    if (scope === "discovery") return; 
    const credential = this.credential;
    if (!credential) return;
    if (scope === "all") delete this.store.credentials.mcpOAuth[this.key];
    else {
      if (scope === "client") delete credential.clientInformation;
      if (scope === "tokens") {
        delete credential.tokens;
        delete credential.expiresAt;
      }
    }
    await this.store.saveCredentials();
  }
}

export class McpOAuthService {
  constructor(private readonly store: McpConfigStore) {}

  async connect(
    server: MCPServerConfig,
    ctx: McpUiContext,
    allowInteractive: boolean,
    connectRaw: (server: MCPServerConfig, provider?: OAuthClientProvider) => Promise<MCPConnection>,
  ): Promise<MCPConnection> {
    server.oauthConfig ??= {};
    const credential = this.store.getOAuthCredential(server);
    if (credential?.tokens) {
      const nonInteractiveProvider = new PersistentOAuthProvider(server, this.store, ctx, false);
      try {
        if (credential.expiresAt && credential.expiresAt <= Date.now() + 30_000) {
          if (!credential.tokens.refresh_token) throw new InteractiveAuthorizationRequiredError();
          const refreshResult = await auth(nonInteractiveProvider, {
            serverUrl: server.url,
            scope: await this.getScope(server),
            fetchFn: safeFetch,
          });
          if (refreshResult !== "AUTHORIZED") throw new InteractiveAuthorizationRequiredError();
        }
        return await connectRaw(server, nonInteractiveProvider);
      } catch (error) {
        if (!(error instanceof InteractiveAuthorizationRequiredError) && !isUnauthorized(error)) throw error;
        if (!allowInteractive) throw new InteractiveAuthorizationRequiredError();
      }
    } else if (!allowInteractive) throw new InteractiveAuthorizationRequiredError();

    const provider = new PersistentOAuthProvider(server, this.store, ctx, true);
    const callback = await this.startCallback(provider).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw new Error(`OAuth callback port ${OAUTH_CALLBACK_PORT} is already in use`);
      throw error;
    });
    let callbackClosed = false;
    const closeCallback = async () => {
      if (callbackClosed) return;
      callbackClosed = true;
      await new Promise<void>(resolve => callback.server.close(() => resolve()));
    };
    try {
      const scope = await this.getScope(server);
      const result = await auth(provider, { serverUrl: server.url, scope, fetchFn: safeFetch });
      if (result !== "REDIRECT") {
        await closeCallback();
        return await connectRaw(server, provider);
      }
      const authorizationCode = await callback.result;
      const finishResult = await auth(provider, { serverUrl: server.url, authorizationCode, scope, fetchFn: safeFetch });
      if (finishResult !== "AUTHORIZED") throw new UnauthorizedError("Failed to authorize");
      await closeCallback();
      return await connectRaw(server, provider);
    } finally {
      await closeCallback();
    }
  }

  private async getScope(server: MCPServerConfig): Promise<string> {
    const configured = server.oauthConfig?.scope?.trim();
    if (configured) return `${configured} offline_access`.split(/\s+/).filter((value, index, all) => all.indexOf(value) === index).join(" ");
    try {
      const discovered = await discoverOAuthServerInfo(server.url, { fetchFn: safeFetch });
      const authorizationServer = parseSafeHttpUrl(discovered.authorizationServerUrl, "OAuth authorization server URL");
      validateProtectedResourceMetadata(discovered.resourceMetadata, parseMcpUrl(server.url));
      validateAuthorizationServerMetadata(discovered.authorizationServerMetadata, authorizationServer);
      return [...new Set([...(discovered.resourceMetadata?.scopes_supported ?? []), "offline_access"])].join(" ");
    } catch {
      return "offline_access";
    }
  }

  private async startCallback(provider: PersistentOAuthProvider): Promise<OAuthCallback> {
    let settled = false;
    let resolveResult!: (code: string) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<string>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
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
    server.on("error", error => { if (!settled) rejectResult(error); });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_HOST, () => { server.off("error", onError); resolve(); });
    });
    const timeout = setTimeout(() => { if (!settled) rejectResult(new Error("OAuth authentication timed out")); }, OAUTH_TIMEOUT_MS);
    timeout.unref();
    result.finally(() => clearTimeout(timeout)).catch(() => {});
    return { server, result };
  }
}

