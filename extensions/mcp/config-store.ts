import {
  CONFIG_DIR_NAME,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { MCPCredentials, MCPConfig, MCPServerConfig, MCPServerRuntime } from "./types.js";
import { isFileMissing, OAUTH_CALLBACK_URL, parseMcpUrl, parseSafeHttpUrl, sanitizeTerminalText } from "./security.js";

const execFileAsync = promisify(execFile);

type ServerMap = Map<string, MCPServerRuntime>;

function persistServer(server: MCPServerRuntime): MCPServerConfig {
  const persisted: MCPServerConfig = {
    name: server.name,
    url: server.url,
    transport: server.transport,
    scope: server.scope,
    enabled: server.enabled,
  };
  if (server.authType !== undefined) persisted.authType = server.authType;
  if (server.bearerTokenEnv !== undefined) persisted.bearerTokenEnv = server.bearerTokenEnv;
  if (server.oauthConfig !== undefined) persisted.oauthConfig = server.oauthConfig;
  return persisted;
}

export class McpConfigStore {
  readonly credentials: MCPCredentials = { mcpOAuth: {}, mcpBearer: {} };
  userConfigPath = "";
  projectConfigPath = "";
  credentialsPath = "";
  projectConfigEnabled = false;
  private credentialsWriteQueue: Promise<void> = Promise.resolve();

  initialize(cwd: string): void {
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    this.userConfigPath = join(agentDir, "mcp-config.json");
    this.projectConfigPath = join(cwd, CONFIG_DIR_NAME, "mcp-config.json");
    this.credentialsPath = join(agentDir, ".credentials.json");
  }

  credentialKey(server: Pick<MCPServerConfig, "name" | "url">): string {
    const normalizedUrl = this.normalizeUrlForCredentialKey(server.url);
    return `${server.name}|${createHash("sha256").update(normalizedUrl).digest("hex").slice(0, 16)}`;
  }

  getOAuthCredential(server: MCPServerConfig) {
    return this.credentials.mcpOAuth[this.credentialKey(server)];
  }

  getBearerToken(server: MCPServerConfig): string | undefined {
    const envToken = server.bearerTokenEnv ? process.env[server.bearerTokenEnv] : undefined;
    return envToken?.trim() || this.credentials.mcpBearer[this.credentialKey(server)]?.token;
  }

  async loadCredentials(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.credentialsPath, "utf8")) as Partial<MCPCredentials>;
      this.credentials.mcpOAuth = this.validOAuthCredentials(parsed.mcpOAuth);
      this.credentials.mcpBearer = this.validBearerCredentials(parsed.mcpBearer);
    } catch (error) {
      if (isFileMissing(error)) {
        this.credentials.mcpOAuth = {};
        this.credentials.mcpBearer = {};
        return;
      }
      throw error;
    }
  }

  async saveCredentials(): Promise<void> {
    const write = this.credentialsWriteQueue.then(async () => {
      await mkdir(dirname(this.credentialsPath), { recursive: true });
      await writeFile(this.credentialsPath, `${JSON.stringify(this.credentials, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await this.secureFile(this.credentialsPath);
    });
    this.credentialsWriteQueue = write.catch(() => {});
    return write;
  }

  validateServerConfig(key: string, server: MCPServerConfig, path: string): MCPServerConfig {
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

  async loadConfig(servers: ServerMap, includeProjectConfig: boolean): Promise<void> {
    this.projectConfigEnabled = includeProjectConfig;
    servers.clear();
    const userConfig = await this.readConfig(this.userConfigPath);
    for (const [name, server] of Object.entries(userConfig?.servers ?? {})) {
      if (server.scope === "user") servers.set(name, server);
    }
    if (!includeProjectConfig) return;
    const projectConfig = await this.readConfig(this.projectConfigPath);
    for (const [name, server] of Object.entries(projectConfig?.servers ?? {})) {
      if (server.scope === "project") servers.set(name, server);
    }
  }

  async saveConfig(servers: ServerMap): Promise<void> {
    const userServers: Record<string, MCPServerConfig> = {};
    const projectServers: Record<string, MCPServerConfig> = {};
    for (const [name, server] of servers) {
      if (server.scope === "user") userServers[name] = persistServer(server);
      else projectServers[name] = persistServer(server);
    }
    await Promise.all([
      this.writeConfig(this.userConfigPath, userServers),
      this.projectConfigEnabled ? this.writeConfig(this.projectConfigPath, projectServers) : Promise.resolve(),
    ]);
  }

  private validOAuthCredentials(value: unknown): MCPCredentials["mcpOAuth"] {
    const result: MCPCredentials["mcpOAuth"] = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;
    for (const [key, credential] of Object.entries(value)) {
      if (!credential || typeof credential !== "object") continue;
      const { clientInformation, tokens, expiresAt } = credential as MCPCredentials["mcpOAuth"][string];
      result[key] = {
        ...(clientInformation && typeof clientInformation === "object" ? { clientInformation } : {}),
        ...(tokens && typeof tokens === "object" ? { tokens } : {}),
        ...(typeof expiresAt === "number" ? { expiresAt } : {}),
      };
    }
    return result;
  }

  private validBearerCredentials(value: unknown): MCPCredentials["mcpBearer"] {
    const result: MCPCredentials["mcpBearer"] = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;
    for (const [key, credential] of Object.entries(value)) {
      const token = (credential as MCPCredentials["mcpBearer"][string])?.token;
      if (typeof token === "string" && token) result[key] = { token };
    }
    return result;
  }

  private async readConfig(path: string): Promise<MCPConfig | undefined> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as MCPConfig;
      if (!parsed || typeof parsed !== "object" || !parsed.servers || typeof parsed.servers !== "object" || Array.isArray(parsed.servers)) {
        throw new Error(`Invalid MCP configuration: ${path}`);
      }
      for (const [key, server] of Object.entries(parsed.servers)) this.validateServerConfig(key, server, path);
      return parsed;
    } catch (error) {
      if (isFileMissing(error)) return undefined;
      throw error;
    }
  }

  private async secureFile(path: string): Promise<void> {
    if (process.platform !== "win32") {
      await chmod(path, 0o600);
      return;
    }
    const username = process.env.USERNAME;
    if (!username) throw new Error(`Cannot secure MCP file without USERNAME: ${path}`);
    const identity = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${username}` : username;
    await execFileAsync("icacls.exe", [path, "/inheritance:r", "/grant:r", `${identity}:(F)`, "*S-1-5-18:(F)", "*S-1-5-32-544:(F)"]);
  }

  private async writeConfig(path: string, servers: Record<string, MCPServerConfig>): Promise<void> {
    if (Object.keys(servers).length === 0 && !(await this.fileExists(path))) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ servers }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await this.secureFile(path);
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch (error) {
      if (isFileMissing(error)) return false;
      throw error;
    }
  }

  private normalizeUrlForCredentialKey(url: string): string {
    const parsed = parseMcpUrl(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) parsed.port = "";
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString();
  }
}
