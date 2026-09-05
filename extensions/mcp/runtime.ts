import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  MCPConnection,
  MCPResource,
  MCPServerConfig,
  MCPServerRuntime,
  MCPTool,
  McpUiContext,
} from "./types.js";
import {
  CLIENT_NAME,
  CLIENT_VERSION,
  getErrorMessage,
  isUnauthorized,
  MAX_DISCOVERY_ITEMS,
  MAX_DISCOVERY_PAGES,
  MCP_REQUEST_TIMEOUT_MS,
  parseMcpUrl,
  safeFetch,
  safeServerName,
} from "./security.js";
import { McpConfigStore } from "./config-store.js";
import { McpOAuthService, InteractiveAuthorizationRequiredError } from "./oauth.js";
import { CompactMcpRenderer, McpToolRegistry } from "./tools.js";
import { registerMcpCommands } from "./commands.js";

export class McpConnectionManager {
  private readonly connections = new Map<string, MCPConnection>();
  readonly pendingTransports = new Set<StreamableHTTPClientTransport>();

  constructor(
    private readonly store: McpConfigStore,
    private readonly oauth: McpOAuthService,
    private readonly isShuttingDown: () => boolean,
  ) {}

  async closeConnection(name: string): Promise<void> {
    const connection = this.connections.get(name);
    this.connections.delete(name);
    if (!connection) return;
    try {
      await connection.client.close();
    } catch {
      try { await connection.transport.close(); } catch { }
    }
  }

  getConnection(name: string): MCPConnection | undefined {
    return this.connections.get(name);
  }

  setConnection(name: string, connection: MCPConnection): void {
    this.connections.set(name, connection);
  }

  hasConnection(name: string): boolean {
    return this.connections.has(name);
  }

  async closeAll(): Promise<void> {
    await Promise.all([
      ...[...this.connections.keys()].map(name => this.closeConnection(name)),
      ...[...this.pendingTransports].map(transport => transport.close().catch(() => {})),
    ]);
    this.pendingTransports.clear();
  }

  async createConnection(server: MCPServerConfig, ctx: McpUiContext, allowInteractive: boolean): Promise<MCPConnection> {
    if (server.transport !== "http") throw new Error("Only Streamable HTTP transport is supported");
    if (server.authType === "bearer" && !this.store.getBearerToken(server)) {
      const hint = server.bearerTokenEnv ? `Set ${server.bearerTokenEnv} and reconnect` : "Configure --bearer-token-env and reconnect";
      throw new Error(`Bearer token missing. ${hint}`);
    }
    if (server.authType === "oauth") {
      return this.oauth.connect(server, ctx, allowInteractive, (target, provider) => this.connectRaw(target, provider));
    }
    return this.connectRaw(server);
  }

  async connectRaw(server: MCPServerConfig, authProvider?: OAuthClientProvider): Promise<MCPConnection> {
    const headers: Record<string, string> = {};
    const bearerToken = this.store.getBearerToken(server);
    if (server.authType === "bearer" && bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
    const transport = new StreamableHTTPClientTransport(parseMcpUrl(server.url), {
      authProvider,
      fetch: safeFetch,
      requestInit: Object.keys(headers).length ? { headers } : undefined,
    });
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
    this.pendingTransports.add(transport);
    try {
      await client.connect(transport, { timeout: MCP_REQUEST_TIMEOUT_MS });
      if (this.isShuttingDown()) {
        await client.close().catch(() => {});
        throw new Error("MCP connection cancelled during session shutdown");
      }
      return { client, transport };
    } catch (error) {
      try { await transport.close(); } catch { }
      throw error;
    } finally {
      this.pendingTransports.delete(transport);
    }
  }

  async listAllTools(client: Client): Promise<MCPTool[]> {
    const tools: MCPTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let pages = 0; ; pages++) {
      if (pages >= MAX_DISCOVERY_PAGES) throw new Error(`MCP tool discovery exceeded ${MAX_DISCOVERY_PAGES} pages`);
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: MCP_REQUEST_TIMEOUT_MS });
      tools.push(...(page.tools as MCPTool[]));
      if (tools.length > MAX_DISCOVERY_ITEMS) throw new Error(`MCP tool discovery exceeded ${MAX_DISCOVERY_ITEMS} items`);
      cursor = page.nextCursor;
      if (!cursor) return tools;
      if (cursors.has(cursor)) throw new Error("MCP tool discovery returned a repeated pagination cursor");
      cursors.add(cursor);
    }
  }

  async listAllResources(client: Client): Promise<MCPResource[]> {
    if (!client.getServerCapabilities()?.resources) return [];
    const resources: MCPResource[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let pages = 0; ; pages++) {
      if (pages >= MAX_DISCOVERY_PAGES) throw new Error(`MCP resource discovery exceeded ${MAX_DISCOVERY_PAGES} pages`);
      const page = await client.listResources(cursor ? { cursor } : undefined, { timeout: MCP_REQUEST_TIMEOUT_MS });
      resources.push(...page.resources);
      if (resources.length > MAX_DISCOVERY_ITEMS) throw new Error(`MCP resource discovery exceeded ${MAX_DISCOVERY_ITEMS} items`);
      cursor = page.nextCursor;
      if (!cursor) return resources;
      if (cursors.has(cursor)) throw new Error("MCP resource discovery returned a repeated pagination cursor");
      cursors.add(cursor);
    }
  }
}

export class McpRuntime {
  readonly servers = new Map<string, MCPServerRuntime>();
  readonly store = new McpConfigStore();
  readonly oauth = new McpOAuthService(this.store);
  readonly renderer = new CompactMcpRenderer();
  readonly connectionManager: McpConnectionManager;
  readonly tools: McpToolRegistry;
  private readonly connectionAttempts = new Map<string, Promise<{ tools: number; resources: number }>>();
  private shuttingDown = false;

  constructor(readonly pi: ExtensionAPI) {
    this.connectionManager = new McpConnectionManager(this.store, this.oauth, () => this.shuttingDown);
    this.tools = new McpToolRegistry(pi, this.renderer, (name, ctx) => this.getConnection(name, ctx));
  }

  register(): void {
    this.pi.on("session_start", async (_event, ctx) => this.sessionStart(ctx as unknown as McpUiContext));
    this.pi.on("session_shutdown", async () => this.shutdown());
    registerMcpCommands(this);
  }

  async sessionStart(ctx: McpUiContext): Promise<void> {
    this.shuttingDown = false;
    this.store.initialize(ctx.cwd);
    await Promise.all([this.store.loadConfig(this.servers, ctx.isProjectTrusted()), this.store.loadCredentials()]);
    for (const server of this.servers.values()) {
      if (server.enabled) this.connectInBackground(server, ctx);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.renderer.dispose();
    await this.connectionManager.closeAll();
    this.connectionAttempts.clear();
  }

  async getConnection(name: string, ctx: McpUiContext) {
    let connection = this.connectionManager.getConnection(name);
    if (connection) return connection;
    const server = this.servers.get(name);
    if (!server?.enabled) throw new Error(`MCP server ${name} is not enabled`);
    const pending = this.connectionAttempts.get(name);
    if (pending) await pending;
    else await this.connectToServer(server, ctx, false);
    connection = this.connectionManager.getConnection(name);
    if (!connection) throw new Error(`MCP server ${name} is not connected`);
    return connection;
  }

  async connectToServer(server: MCPServerRuntime, ctx: McpUiContext, allowAuthPrompt = true): Promise<{ tools: number; resources: number }> {
    await this.connectionManager.closeConnection(server.name);
    if (allowAuthPrompt) ctx.ui.notify(`Connecting to ${safeServerName(server)} (${server.scope})...`, "info");
    try {
      let connection;
      const hasOAuthToken = Boolean(this.store.getOAuthCredential(server)?.tokens);
      if (server.authType === "oauth" && !hasOAuthToken) {
        if (!allowAuthPrompt || !ctx.hasUI) throw new Error(`Authentication required. Run /mcp auth ${safeServerName(server)}`);
        const authenticate = await ctx.ui.confirm("MCP authentication required", `Open the browser to authenticate ${safeServerName(server)}?`);
        if (!authenticate) throw new Error(`Authentication required. Run /mcp auth ${safeServerName(server)}`);
      }
      try {
        connection = await this.connectionManager.createConnection(server, ctx, allowAuthPrompt && ctx.hasUI);
      } catch (error) {
        if (!(error instanceof InteractiveAuthorizationRequiredError) &&
          (!isUnauthorized(error) || server.authType === "bearer")) throw error;
        if (!allowAuthPrompt || !ctx.hasUI) throw new Error(`Authentication required. Run /mcp auth ${safeServerName(server)}`);
        const authenticate = await ctx.ui.confirm("MCP authentication required", `Open the browser to authenticate ${safeServerName(server)}?`);
        if (!authenticate) throw new Error(`Authentication required. Run /mcp auth ${safeServerName(server)}`);
        server.authType = "oauth";
        server.oauthConfig ??= {};
        await this.store.saveConfig(this.servers);
        connection = await this.connectionManager.createConnection(server, ctx, true);
      }
      this.connectionManager.setConnection(server.name, connection);
      const tools = await this.connectionManager.listAllTools(connection.client);
      const resources = await this.connectionManager.listAllResources(connection.client);
      if (this.shuttingDown) {
        await this.connectionManager.closeConnection(server.name);
        throw new Error("MCP connection cancelled during session shutdown");
      }
      server.tools = tools;
      server.resources = resources;
      server.lastConnected = Date.now();
      delete server.error;
      this.tools.registerServerTools(server);
      return { tools: tools.length, resources: resources.length };
    } catch (error) {
      const message = getErrorMessage(error);
      await this.connectionManager.closeConnection(server.name);
      if (!this.shuttingDown) server.error = message;
      throw new Error(message);
    }
  }

  connectInBackground(server: MCPServerRuntime, ctx: McpUiContext) {
    const existing = this.connectionAttempts.get(server.name);
    if (existing) return existing;
    const attempt = this.connectToServer(server, ctx, false);
    this.connectionAttempts.set(server.name, attempt);
    void attempt.catch(error => {
      if (!this.shuttingDown) ctx.ui.notify(`${safeServerName(server)}: ${getErrorMessage(error)}`, "error");
    }).finally(() => {
      if (this.connectionAttempts.get(server.name) === attempt) this.connectionAttempts.delete(server.name);
    });
    return attempt;
  }

  async addServer(server: MCPServerRuntime, ctx: McpUiContext) {
    this.servers.set(server.name, server);
    await this.store.saveConfig(this.servers);
    return this.connectToServer(server, ctx);
  }

  async removeServer(name: string): Promise<MCPServerRuntime> {
    const server = this.servers.get(name);
    if (!server) throw new Error(`MCP server ${name} not found`);
    server.enabled = false;
    this.tools.deactivateServerTools(name);
    await this.connectionManager.closeConnection(name);
    delete this.store.credentials.mcpOAuth[this.store.credentialKey(server)];
    delete this.store.credentials.mcpBearer[this.store.credentialKey(server)];
    this.servers.delete(name);
    await Promise.all([this.store.saveConfig(this.servers), this.store.saveCredentials()]);
    return server;
  }

  async setServerEnabled(name: string, enabled: boolean, ctx: McpUiContext) {
    const server = this.servers.get(name);
    if (!server) throw new Error(`MCP server ${name} not found`);
    server.enabled = enabled;
    if (!enabled) {
      this.tools.deactivateServerTools(name);
      await this.connectionManager.closeConnection(name);
      await this.store.saveConfig(this.servers);
      return undefined;
    }
    await this.store.saveConfig(this.servers);
    return this.connectToServer(server, ctx);
  }

  async authenticate(name: string, ctx: McpUiContext) {
    const server = this.servers.get(name);
    if (!server) throw new Error(`MCP server ${name} not found`);
    server.authType = "oauth";
    server.oauthConfig ??= {};
    delete this.store.credentials.mcpOAuth[this.store.credentialKey(server)];
    delete this.store.credentials.mcpBearer[this.store.credentialKey(server)];
    await Promise.all([this.store.saveConfig(this.servers), this.store.saveCredentials()]);
    return this.connectToServer(server, ctx);
  }
}
