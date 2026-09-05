import type { McpUiContext, MCPServerConfig } from "./types.js";
import type { McpRuntime } from "./runtime.js";
import { getErrorMessage, parseMcpUrl, safeServerName, sanitizeTerminalText } from "./security.js";

export function registerMcpCommands(runtime: McpRuntime): void {
  runtime.pi.registerCommand("mcp", {
    description: "Manage MCP servers",
    handler: async (args, rawCtx) => {
      const ctx = rawCtx as unknown as McpUiContext;
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.includes("--token")) {
        ctx.ui.notify("Do not place bearer tokens in command text. Use --bearer-token-env <ENV_VAR>.", "error");
        return;
      }
      const command = parts[0];
      if (command === "add") await handleAdd(runtime, parts, ctx);
      else if (command === "remove") await handleRemove(runtime, parts, ctx);
      else if (command === "enable") await handleEnable(runtime, parts, ctx);
      else if (command === "disable") await handleDisable(runtime, parts, ctx);
      else if (command === "connect") await handleConnect(runtime, parts, ctx);
      else if (command === "auth") await handleAuth(runtime, parts, ctx);
      else if (command === "list") displayServers(runtime, ctx, parts.includes("--details"));
      else displayHelp(ctx);
    },
  });
}

function displayHelp(ctx: McpUiContext): void {
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

function displayServers(runtime: McpRuntime, ctx: McpUiContext, details: boolean): void {
  if (runtime.servers.size === 0) {
    ctx.ui.notify("No MCP servers configured", "info");
    return;
  }
  const lines: string[] = [];
  for (const scope of ["user", "project"] as const) {
    const scoped = [...runtime.servers.values()].filter(server => server.scope === scope);
    if (!scoped.length) continue;
    lines.push(`${scope.toUpperCase()} (${scoped.length})`);
    if (details) lines.push(`Config: ${scope === "user" ? runtime.store.userConfigPath : runtime.store.projectConfigPath}`);
    for (const server of scoped) {
      const state = server.enabled ? "enabled" : "disabled";
      const connected = runtime.connectionManager.hasConnection(server.name) ? "connected" : "disconnected";
      lines.push(`  ${safeServerName(server)}: ${sanitizeTerminalText(server.url, { multiline: false })} [${state}, ${connected}, ${server.authType ?? "none"}]`);
      lines.push(`    ${(server.tools?.length ?? 0)} tools, ${(server.resources?.length ?? 0)} resources${server.error ? `; ${sanitizeTerminalText(server.error)}` : ""}`);
    }
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

async function handleAdd(runtime: McpRuntime, parts: string[], ctx: McpUiContext): Promise<void> {
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
      if (!value) { parseError = `Missing value for ${part}`; break; }
      if (part === "--transport") transport = value as "http" | "stdio";
      else if (part === "--scope") scope = value as "user" | "project";
      else if (part === "--auth") authType = value as "none" | "oauth" | "bearer";
      else if (part === "--oauth-scope") oauthScope = value;
      else bearerTokenEnv = value;
    } else if (part.startsWith("--")) { parseError = `Unknown option: ${part}`; break; }
    else positional.push(part);
  }
  const [name, url, ...extra] = positional;
  const validAuthType = ["none", "oauth", "bearer"].includes(authType);
  const validEnv = !bearerTokenEnv || /^[A-Za-z_][A-Za-z0-9_]*$/.test(bearerTokenEnv);
  const validOAuthScope = !oauthScope || /^[\x21\x23-\x5B\x5D-\x7E]{1,2048}$/.test(oauthScope);
  if (parseError || transport !== "http" || !["user", "project"].includes(scope ?? "") || !validAuthType || !validEnv || !validOAuthScope ||
      !name || !url || extra.length > 0 || (bearerTokenEnv && authType !== "bearer") || (authType === "bearer" && !bearerTokenEnv) || (oauthScope && authType !== "oauth")) {
    ctx.ui.notify(`${parseError ? `${parseError}\n` : ""}Usage: /mcp add --transport http --scope <user|project> <name> <url> [--auth <none|oauth|bearer>] [--oauth-scope <scope>] [--bearer-token-env <ENV_VAR>]`, "error");
    return;
  }
  try { parseMcpUrl(url); } catch (error) { ctx.ui.notify(`Invalid MCP URL: ${getErrorMessage(error)}`, "error"); return; }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
    ctx.ui.notify("MCP server names must be 1-128 characters using letters, numbers, dot, underscore, or hyphen", "error"); return;
  }
  if (runtime.servers.has(name)) {
    ctx.ui.notify(`MCP server \"${sanitizeTerminalText(name, { multiline: false })}\" already exists`, "error"); return;
  }
  if (scope === "project" && !ctx.isProjectTrusted()) {
    ctx.ui.notify("Project-scoped MCP servers require a trusted project", "error"); return;
  }
  const server: MCPServerConfig = { name, url, transport, scope: scope!, enabled: true, authType, bearerTokenEnv, oauthConfig: authType === "oauth" ? { scope: oauthScope } : undefined };
  try {
    const result = await runtime.addServer(server, ctx);
    ctx.ui.notify(`Added ${safeServerName(server)}: ${result.tools} tools, ${result.resources} resources`, "info");
  } catch (error) {
    ctx.ui.notify(`Added ${safeServerName(server)}, but connection failed: ${getErrorMessage(error)}`, "warning");
  }
}

async function handleRemove(runtime: McpRuntime, parts: string[], ctx: McpUiContext): Promise<void> {
  const name = parts[1];
  if (!name || !runtime.servers.has(name)) {
    ctx.ui.notify(name ? `MCP server \"${name}\" not found` : "Usage: /mcp remove <name>", "error"); return;
  }
  const server = await runtime.removeServer(name);
  ctx.ui.notify(`Removed ${name} from ${server.scope} scope`, "info");
}

async function handleEnable(runtime: McpRuntime, parts: string[], ctx: McpUiContext): Promise<void> {
  const name = parts[1];
  if (!name || !runtime.servers.has(name)) { ctx.ui.notify("Usage: /mcp enable <name>", "error"); return; }
  try {
    const result = await runtime.setServerEnabled(name, true, ctx);
    ctx.ui.notify(`Enabled ${safeServerName(runtime.servers.get(name)!)}: ${result!.tools} tools, ${result!.resources} resources`, "info");
  } catch (error) {
    ctx.ui.notify(`Enabled ${safeServerName(runtime.servers.get(name)!)}, but connection failed: ${getErrorMessage(error)}`, "warning");
  }
}

async function handleDisable(runtime: McpRuntime, parts: string[], ctx: McpUiContext): Promise<void> {
  const name = parts[1];
  if (!name || !runtime.servers.has(name)) { ctx.ui.notify("Usage: /mcp disable <name>", "error"); return; }
  await runtime.setServerEnabled(name, false, ctx);
  ctx.ui.notify(`Disabled ${safeServerName(runtime.servers.get(name)!)}`, "info");
}

async function handleConnect(runtime: McpRuntime, parts: string[], ctx: McpUiContext): Promise<void> {
  const name = parts[1];
  if (!name || !runtime.servers.has(name)) { ctx.ui.notify("Usage: /mcp connect <name>", "error"); return; }
  try {
    const result = await runtime.connectToServer(runtime.servers.get(name)!, ctx);
    ctx.ui.notify(`Connected ${safeServerName(runtime.servers.get(name)!)}: ${result.tools} tools, ${result.resources} resources`, "info");
  } catch (error) { ctx.ui.notify(`Connection failed: ${getErrorMessage(error)}`, "error"); }
}

async function handleAuth(runtime: McpRuntime, parts: string[], ctx: McpUiContext): Promise<void> {
  const name = parts[1];
  const server = name ? runtime.servers.get(name) : undefined;
  if (!server) { ctx.ui.notify("Usage: /mcp auth <name>", "error"); return; }
  if (!ctx.hasUI) { ctx.ui.notify("MCP authentication requires an interactive UI", "error"); return; }
  if (server.authType === "bearer") {
    ctx.ui.notify(server.bearerTokenEnv
      ? `Bearer credentials are read from ${server.bearerTokenEnv}. Set it in Pi's environment, then run /mcp connect ${safeServerName(server)}.`
      : "Pi exposes no supported masked secret input to ordinary extensions. Re-add this server with --bearer-token-env <ENV_VAR>; ordinary ui.input is intentionally not used.", "warning");
    return;
  }
  try {
    const result = await runtime.authenticate(name, ctx);
    ctx.ui.notify(`Authenticated ${safeServerName(server)}: ${result.tools} tools, ${result.resources} resources`, "info");
  } catch (error) { ctx.ui.notify(`Authentication failed: ${getErrorMessage(error)}`, "error"); }
}
