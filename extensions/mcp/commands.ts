  // MCP 命令处理
  pi.registerCommand("mcp", {
    description: "Manage MCP servers",
    handler: async (args, ctx) => {
      if (!args) {
        // 列出所有服务器
        if (servers.size === 0) {
          ctx.ui.notify(
            "No MCP servers configured.\n\n" +
            "Add server:\n" +
            "  /mcp add --transport http --scope user <name> <url>\n" +
            "  /mcp add --transport http --scope project <name> <url>\n\n" +
            "Examples:\n" +
            "  /mcp add --transport http --scope user cafe https://api.codes.cafe/mcp\n" +
            "  /mcp add --transport http --scope project local http://localhost:3000",
            "info"
          );
          return;
        }

        const lines: string[] = [];
        const userServers = Array.from(servers.values()).filter(s => s.scope === "user");
        const projectServers = Array.from(servers.values()).filter(s => s.scope === "project");

        if (userServers.length > 0) {
          lines.push(`\n=== User Scope (${userServers.length}) ===`);
          for (const server of userServers) {
            const status = server.enabled ? "✓" : "✗";
            const auth = server.authType !== "none" ? ` [${server.authType}]` : "";
            const toolCount = server.tools?.length || 0;
            const resourceCount = server.resources?.length || 0;
            const error = server.error ? ` ⚠ ${server.error}` : "";
            lines.push(`  ${status} ${server.name}: ${server.url}${auth}`);
            lines.push(`    └─ ${toolCount} tools, ${resourceCount} resources${error}`);
          }
        }

        if (projectServers.length > 0) {
          lines.push(`\n=== Project Scope (${projectServers.length}) ===`);
          for (const server of projectServers) {
            const status = server.enabled ? "✓" : "✗";
            const auth = server.authType !== "none" ? ` [${server.authType}]` : "";
            const toolCount = server.tools?.length || 0;
            const resourceCount = server.resources?.length || 0;
            const error = server.error ? ` ⚠ ${server.error}` : "";
            lines.push(`  ${status} ${server.name}: ${server.url}${auth}`);
            lines.push(`    └─ ${toolCount} tools, ${resourceCount} resources${error}`);
          }
        }

        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      const parts = args.trim().split(/\s+/);
      const command = parts[0];

      if (command === "add") {
        await handleAddCommand(parts, ctx);
      } else if (command === "remove") {
        await handleRemoveCommand(parts, ctx);
      } else if (command === "enable") {
        await handleEnableCommand(parts, ctx);
      } else if (command === "disable") {
        await handleDisableCommand(parts, ctx);
      } else if (command === "list") {
        await handleListCommand(ctx);
      } else if (command === "connect") {
        await handleConnectCommand(parts, ctx);
      } else if (command === "auth") {
        await handleAuthCommand(parts, ctx);
      } else {
        ctx.ui.notify(
          "MCP Commands:\n\n" +
          "  /mcp                                       List servers\n" +
          "  /mcp add --transport <t> --scope <s> ...   Add server\n" +
          "  /mcp remove <name>                         Remove server\n" +
          "  /mcp enable <name>                         Enable server\n" +
          "  /mcp disable <name>                        Disable server\n" +
          "  /mcp connect <name>                        Connect/reconnect\n" +
          "  /mcp auth <name>                           Authenticate\n" +
          "  /mcp list                                  Show details\n\n" +
          "Examples:\n" +
          "  /mcp add --transport http --scope user cafe https://api.codes.cafe/mcp\n" +
          "  /mcp add --transport http --scope project local http://localhost:3000\n" +
          "  /mcp remove cafe",
          "info"
        );
      }
    },
  });

  async function handleAddCommand(parts: string[], ctx: any) {
    // 解析参数: add --transport http --scope user name url [--auth ...] 
    let transport: "http" | "stdio" | undefined;
    let scope: "user" | "project" | undefined;
    let name: string | undefined;
    let url: string | undefined;
    let authType: "none" | "oauth" | "bearer" = "none";
    let authUrl: string | undefined;
    let token: string | undefined;

    let i = 1;
    while (i < parts.length) {
      if (parts[i] === "--transport" && i + 1 < parts.length) {
        transport = parts[++i] as any;
      } else if (parts[i] === "--scope" && i + 1 < parts.length) {
        scope = parts[++i] as any;
      } else if (parts[i] === "--auth" && i + 1 < parts.length) {
        authType = parts[++i] as any;
      } else if (parts[i] === "--oauth-url" && i + 1 < parts.length) {
        authUrl = parts[++i];
      } else if (parts[i] === "--token" && i + 1 < parts.length) {
        token = parts[++i];
      } else if (!name) {
        name = parts[i];
      } else if (!url) {
        url = parts[i];
      }
      i++;
    }

    if (!transport || !scope || !name || !url) {
      ctx.ui.notify(
        "Usage: /mcp add --transport <http|stdio> --scope <user|project> <name> <url> [options]\n\n" +
        "Options:\n" +
        "  --auth <type>       Auth type: none, oauth, bearer\n" +
        "  --oauth-url <url>   OAuth authorization URL\n" +
        "  --token <token>     Bearer token\n\n" +
        "Examples:\n" +
        "  /mcp add --transport http --scope user cafe https://api.codes.cafe/mcp\n" +
        "  /mcp add --transport http --scope project local http://localhost:3000",
        "error"
      );
      return;
    }

    if (servers.has(name)) {
      const existing = servers.get(name)!;
      ctx.ui.notify(
        `Server "${name}" already exists in ${existing.scope} scope.\n` +
        `Remove it first with: /mcp remove ${name}`,
        "error"
      );
      return;
    }

    const server: MCPServerConfig = {
      name,
      url,
      transport,
      scope,
      enabled: true,
      authType,
    };

    if (authUrl) {
      server.oauthConfig = { authUrl };
    }

    if (token) {
      server.token = token;
    }

    servers.set(name, server);

    try {
      const result = await connectToServer(server, ctx);
      ctx.ui.notify(
        `✓ Added "${name}" (${scope} scope)\n` +
        `  Transport: ${transport}\n` +
        `  URL: ${url}\n` +
        `  Auth: ${authType}\n` +
        `  Tools: ${result.tools}\n` +
        `  Resources: ${result.resources}\n\n` +
        `Config saved to: ${scope === "user" ? userConfigPath : projectConfigPath}`,
        "info"
      );
    } catch (error: any) {
      ctx.ui.notify(
        `Added "${name}" but connection failed: ${error.message}\n` +
        `Use /mcp connect ${name} to retry.`,
        "warning"
      );
    }
  }

  async function handleRemoveCommand(parts: string[], ctx: any) {
    if (parts.length < 2) {
      ctx.ui.notify("Usage: /mcp remove <name>", "error");
      return;
    }

    const name = parts[1];
    const server = servers.get(name);
    
    if (!server) {
      ctx.ui.notify(`Server "${name}" not found`, "error");
      return;
    }

    const scope = server.scope;
    servers.delete(name);
    await saveConfig();
    
    ctx.ui.notify(
      `Removed "${name}" from ${scope} scope.\n\n` +
      `Run /reload to unregister tools.`,
      "info"
    );
  }

  async function handleEnableCommand(parts: string[], ctx: any) {
    if (parts.length < 2) {
      ctx.ui.notify("Usage: /mcp enable <name>", "error");
      return;
    }

    const name = parts[1];
    const server = servers.get(name);
    
    if (!server) {
      ctx.ui.notify(`Server "${name}" not found`, "error");
      return;
    }

    server.enabled = true;
    await saveConfig();

    try {
      const result = await connectToServer(server, ctx);
      ctx.ui.notify(
        `✓ Enabled "${name}" (${server.scope} scope)\n` +
        `  Tools: ${result.tools}\n` +
        `  Resources: ${result.resources}`,
        "info"
      );
    } catch (error: any) {
      ctx.ui.notify(
        `Enabled "${name}" but connection failed: ${error.message}`,
        "warning"
      );
    }
  }

  async function handleDisableCommand(parts: string[], ctx: any) {
    if (parts.length < 2) {
      ctx.ui.notify("Usage: /mcp disable <name>", "error");
      return;
    }

    const name = parts[1];
    const server = servers.get(name);
    
    if (!server) {
      ctx.ui.notify(`Server "${name}" not found`, "error");
      return;
    }

    server.enabled = false;
    await saveConfig();
    ctx.ui.notify(
      `Disabled "${name}" (${server.scope} scope)\n\n` +
      `Run /reload to unregister tools.`,
      "info"
    );
  }

  async function handleConnectCommand(parts: string[], ctx: any) {
    if (parts.length < 2) {
      ctx.ui.notify("Usage: /mcp connect <name>", "error");
      return;
    }

    const name = parts[1];
    const server = servers.get(name);
    
    if (!server) {
      ctx.ui.notify(`Server "${name}" not found`, "error");
      return;
    }

    try {
      const result = await connectToServer(server, ctx);
      ctx.ui.notify(
        `✓ Connected to "${name}" (${server.scope} scope)\n` +
        `  Tools: ${result.tools}\n` +
        `  Resources: ${result.resources}`,
        "info"
      );
    } catch (error: any) {
      ctx.ui.notify(`Connection failed: ${error.message}`, "error");
    }
  }

  async function handleAuthCommand(parts: string[], ctx: any) {
    if (parts.length < 2) {
      ctx.ui.notify("Usage: /mcp auth <name>", "error");
      return;
    }

    const name = parts[1];
    const server = servers.get(name);
    
    if (!server) {
      ctx.ui.notify(`Server "${name}" not found`, "error");
      return;
    }

    if (server.authType === "oauth") {
      try {
        await startOAuthFlow(server, ctx);
        ctx.ui.notify("Authentication successful", "info");
      } catch (error: any) {
        ctx.ui.notify(`Authentication failed: ${error.message}`, "error");
      }
    } else if (server.authType === "bearer") {
      const token = await ctx.ui.input(
        "Enter bearer token:",
        { placeholder: "Paste token..." }
      );
      if (token) {
        server.token = token;
        await saveConfig();
        ctx.ui.notify("Token saved", "info");
      }
    } else {
      ctx.ui.notify(`Server "${name}" doesn't require authentication`, "info");
    }
  }

  async function handleListCommand(ctx: any) {
    if (servers.size === 0) {
      ctx.ui.notify("No servers configured", "info");
      return;
    }

    const userServers = Array.from(servers.values()).filter(s => s.scope === "user");
    const projectServers = Array.from(servers.values()).filter(s => s.scope === "project");

    if (userServers.length > 0) {
      ctx.ui.notify(`\n${"=".repeat(60)}`, "info");
      ctx.ui.notify(`USER SCOPE (${userServers.length})`, "info");
      ctx.ui.notify(`Config: ${userConfigPath}`, "info");
      ctx.ui.notify(`${"=".repeat(60)}`, "info");

      for (const server of userServers) {
        displayServerDetails(server, ctx);
      }
    }

    if (projectServers.length > 0) {
      ctx.ui.notify(`\n${"=".repeat(60)}`, "info");
      ctx.ui.notify(`PROJECT SCOPE (${projectServers.length})`, "info");
      ctx.ui.notify(`Config: ${projectConfigPath}`, "info");
      ctx.ui.notify(`${"=".repeat(60)}`, "info");

      for (const server of projectServers) {
        displayServerDetails(server, ctx);
      }
    }
  }

  function displayServerDetails(server: MCPServerConfig, ctx: any) {
    const status = server.enabled ? "✓ enabled" : "✗ disabled";
    const authInfo = server.authType !== "none" 
      ? `\nAuth: ${server.authType}${server.token ? " (authenticated)" : " (not authenticated)"}`
      : "";

    ctx.ui.notify(
      `\nServer: ${server.name} [${status}]\n` +
      `Transport: ${server.transport}\n` +
      `URL: ${server.url}${authInfo}`,
      "info"
    );

    if (server.error) {
      ctx.ui.notify(`⚠ Error: ${server.error}`, "error");
    }

    if (server.tools && server.tools.length > 0) {
      ctx.ui.notify(`\nTools (${server.tools.length}):`, "info");
      for (const tool of server.tools) {
        const toolId = `mcp_${server.name}_${tool.name}`.replace(/[^a-zA-Z0-9_]/g, "_");
        ctx.ui.notify(
          `  • ${tool.name}\n` +
          `    ID: ${toolId}\n` +
          `    ${tool.description || "No description"}`,
          "info"
        );
      }
    }

    if (server.resources && server.resources.length > 0) {
      ctx.ui.notify(`\nResources (${server.resources.length}):`, "info");
      for (const resource of server.resources) {
        ctx.ui.notify(
          `  • ${resource.uri}\n` +
          `    ${resource.description || resource.name}`,
          "info"
        );
      }
    }

    if (server.lastConnected) {
      const date = new Date(server.lastConnected).toLocaleString();
      ctx.ui.notify(`\nLast connected: ${date}`, "info");
    }

    ctx.ui.notify("", "info");
  }

  // 测试命令
  pi.registerCommand("mcp-test", {
    description: "Test MCP server connection",
    handler: async (args, ctx) => {
      if (!args || !args.trim()) {
        ctx.ui.notify(
          "Usage: /mcp-test <url>\n\n" +
          "Example: /mcp-test https://api.codes.cafe/mcp",
          "info"
        );
        return;
      }

      const url = args.trim();
      const testServer: MCPServerConfig = {
        name: "test",
        url,
        transport: "http",
        scope: "user",
        enabled: true,
        authType: "none",
      };
      
      ctx.ui.notify(`Testing: ${url}`, "info");

      try {
        const tools = await fetchMCPTools(testServer);
        const resources = await fetchMCPResources(testServer);

        ctx.ui.notify(
          `✓ Connection successful!\n\n` +
          `Tools: ${tools.length}\n` +
          `Resources: ${resources.length}`,
          "info"
        );

        if (tools.length > 0) {
          ctx.ui.notify("\nTools:", "info");
          for (const tool of tools.slice(0, 10)) {
            ctx.ui.notify(`  • ${tool.name}: ${tool.description || "No description"}`, "info");
          }
          if (tools.length > 10) {
            ctx.ui.notify(`  ... and ${tools.length - 10} more`, "info");
          }
        }

        if (resources.length > 0) {
          ctx.ui.notify("\nResources:", "info");
          for (const resource of resources.slice(0, 5)) {
            ctx.ui.notify(`  • ${resource.uri}`, "info");
          }
          if (resources.length > 5) {
            ctx.ui.notify(`  ... and ${resources.length - 5} more`, "info");
          }
        }

        ctx.ui.notify(
          `\nTo add:\n` +
          `/mcp add --transport http --scope user <name> ${url}\n` +
          `/mcp add --transport http --scope project <name> ${url}`,
          "info"
        );
      } catch (error: any) {
        ctx.ui.notify(`✗ Failed: ${error.message}`, "error");
      }
    },
  });
}
