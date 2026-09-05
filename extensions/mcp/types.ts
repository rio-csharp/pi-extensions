import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Server as HttpServer } from "node:http";

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface OAuthConfig {
  authUrl?: string;
  tokenUrl?: string;
  redirectUri?: string;
  scope?: string;
}

export interface PersistedOAuthCredential {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  expiresAt?: number;
}

export interface PersistedBearerCredential {
  token: string;
}

export interface MCPCredentials {
  mcpOAuth: Record<string, PersistedOAuthCredential>;
  mcpBearer: Record<string, PersistedBearerCredential>;
}

export interface MCPServerConfig {
  name: string;
  url: string;
  transport: "http" | "stdio";
  scope: "user" | "project";
  enabled: boolean;
  authType?: "none" | "oauth" | "bearer";
  bearerTokenEnv?: string;
  oauthConfig?: OAuthConfig;
}

export interface MCPServerRuntime extends MCPServerConfig {
  tools?: MCPTool[];
  resources?: MCPResource[];
  lastConnected?: number;
  error?: string;
}

export interface MCPConfig {
  servers: Record<string, MCPServerConfig>;
}

export interface MCPConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

export interface OAuthCallback {
  server: HttpServer;
  result: Promise<string>;
}

export interface McpUiContext {
  hasUI: boolean;
  cwd: string;
  isProjectTrusted(): boolean;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    confirm(title: string, message: string): Promise<boolean>;
  };
}
