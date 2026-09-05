import { Text, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import type { MCPConnection, MCPServerRuntime, McpUiContext } from "./types.js";
import { getErrorMessage, safeServerName, safeToolName, sanitizeTerminalText } from "./security.js";

// ---------- Result formatting ----------

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

export function schemaToTypeBox(schema: any, required = true): any {
  const options = schema?.description ? { description: sanitizeTerminalText(schema.description) } : {};
  let converted: any;
  if (Array.isArray(schema?.enum) && schema.enum.length > 0) {
    converted = Type.Union(schema.enum.map((value: any) => Type.Literal(value)), options);
  } else {
    switch (schema?.type) {
      case "string": converted = Type.String(options); break;
      case "number": converted = Type.Number(options); break;
      case "integer": converted = Type.Integer(options); break;
      case "boolean": converted = Type.Boolean(options); break;
      case "array": converted = Type.Array(schema.items ? schemaToTypeBox(schema.items) : Type.Any(), options); break;
      case "object": {
        const requiredProperties = new Set<string>(schema.required ?? []);
        const properties: Record<string, any> = {};
        for (const [key, property] of Object.entries(schema.properties ?? {})) {
          properties[key] = schemaToTypeBox(property, requiredProperties.has(key));
        }
        converted = Type.Object(properties, options);
        break;
      }
      default: converted = Type.Any(options);
    }
  }
  return required ? converted : Type.Optional(converted);
}

function truncateRemoteOutput(value: string): string {
  const truncated = truncateHead(sanitizeTerminalText(value, { maxLength: DEFAULT_MAX_BYTES * 4 }), {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
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

// ---------- Compact call rendering ----------

interface CompactMcpRenderState {
  calledAt?: number;
  startedAt?: number;
  finishedAt?: number;
  progressText?: string;
  callText?: Text;
}

interface CompactMcpRenderContext {
  args: Record<string, unknown>;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: unknown;
  state: CompactMcpRenderState;
  executionStarted: boolean;
  isPartial: boolean;
  isError: boolean;
}

export class CompactMcpRenderer {
  private spinnerIndex = 0;
  private renderTicker: ReturnType<typeof setInterval> | undefined;
  private readonly invalidators = new Map<string, () => void>();
  private readonly spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  render(
    server: MCPServerRuntime,
    toolName: string,
    args: Record<string, unknown>,
    theme: any,
    context: CompactMcpRenderContext,
  ): Text {
    const state = context.state;
    const now = Date.now();
    state.calledAt ??= now;
    if (context.executionStarted) state.startedAt ??= now;
    if (!context.isPartial) state.finishedAt ??= now;

    if (context.executionStarted && context.isPartial) {
      this.invalidators.set(context.toolCallId, context.invalidate);
      this.ensureTicker();
    } else if (!context.isPartial) {
      this.invalidators.delete(context.toolCallId);
      this.stopTickerIfIdle();
    }

    const icon = !context.executionStarted
      ? theme.fg("dim", "○")
      : context.isPartial
        ? theme.fg("accent", this.spinnerFrames[this.spinnerIndex])
        : context.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const timestamp = theme.fg("dim", `[${this.formatClock(state.calledAt)}]`);
    const label = theme.fg("toolTitle", theme.bold(`mcp ${safeServerName(server)}/${safeToolName(toolName)}`));
    const elapsed = state.startedAt === undefined ? "" : theme.fg("dim", ` · ${this.formatElapsed((state.finishedAt ?? now) - state.startedAt)}`);
    const progress = context.isPartial && state.progressText
      ? theme.fg("dim", ` · ${sanitizeTerminalText(state.progressText, { multiline: false, maxLength: 1024 })}`)
      : "";
    const prefix = `${timestamp} ${icon} ${label}${elapsed}${progress}`;
    const lines = this.formatArgs(args).split("\n");
    const indent = " ".repeat(visibleWidth(prefix) + 3);
    let output = `${prefix} · ${lines[0] ?? ""}`;
    for (const line of lines.slice(1)) output += `\n${indent}${line}`;

    let text = state.callText;
    if (!text && context.lastComponent instanceof Text) text = context.lastComponent;
    text ??= new Text("", 0, 0);
    state.callText = text;
    text.setText(output);
    return text;
  }

  dispose(): void {
    if (this.renderTicker) clearInterval(this.renderTicker);
    this.renderTicker = undefined;
    this.invalidators.clear();
  }

  private ensureTicker(): void {
    if (this.renderTicker) return;
    this.renderTicker = setInterval(() => {
      this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length;
      for (const invalidate of this.invalidators.values()) invalidate();
    }, 100);
    this.renderTicker.unref?.();
  }

  private stopTickerIfIdle(): void {
    if (this.invalidators.size !== 0 || !this.renderTicker) return;
    clearInterval(this.renderTicker);
    this.renderTicker = undefined;
  }

  private formatClock(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }

  private formatElapsed(milliseconds: number): string {
    return milliseconds < 1000 ? `${Math.max(0, Math.round(milliseconds))}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
  }

  private formatArgs(args: Record<string, unknown>): string {
    const entries = Object.entries(args ?? {});
    if (entries.length === 0) return "{}";
    return entries.map(([key, value]) => `${sanitizeTerminalText(key, { multiline: false, maxLength: 256 })}=${this.compactValue(key, value)}`).join(" ");
  }

  private compactValue(key: string, value: unknown): string {
    if (/(?:authorization|token|secret|password|cookie|api[-_]?key|credential|signature)/i.test(key)) return "<redacted>";
    if (typeof value === "string") {
      if (value.length > 160 || /(?:content|text|markdown|json|chunk|body|data)/i.test(key)) return `<${Buffer.byteLength(value, "utf8")} bytes>`;
      return JSON.stringify(sanitizeTerminalText(value, { multiline: false, maxLength: 512 }));
    }
    if (Array.isArray(value)) return `<${value.length} items>`;
    if (value && typeof value === "object") return `<${Object.keys(value as Record<string, unknown>).length} fields>`;
    return JSON.stringify(value);
  }
}

// ---------- Tool registration ----------

export class McpToolRegistry {
  private readonly registeredToolNames = new Map<string, Set<string>>();

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly renderer: CompactMcpRenderer,
    private readonly getConnection: (name: string, ctx: McpUiContext) => Promise<MCPConnection>,
  ) {}

  deactivateServerTools(name: string): void {
    const names = this.registeredToolNames.get(name);
    if (!names?.size) return;
    this.pi.setActiveTools(this.pi.getActiveTools().filter(toolName => !names.has(toolName)));
  }

  registerServerTools(server: MCPServerRuntime): void {
    if (!server.enabled) return;
    this.deactivateServerTools(server.name);
    const names = new Set<string>();
    const usedNames = new Set(this.pi.getAllTools().map(tool => tool.name));
    for (const name of this.registeredToolNames.get(server.name) ?? []) usedNames.delete(name);
    const getConnection = this.getConnection;
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
      this.pi.registerTool({
        name: registeredName,
        label: `${displayServerName}: ${displayToolName}`,
        description: sanitizeTerminalText(tool.description || `MCP tool ${displayToolName}`),
        parameters: schemaToTypeBox(tool.inputSchema),
        renderShell: "self",
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          if (!server.enabled) throw new Error(`MCP server ${server.name} is disabled`);
          onUpdate?.({ content: [{ type: "text", text: `Calling ${displayToolName}...` }], details: { server: displayServerName, tool: displayToolName } });
          try {
            const connection = await getConnection(server.name, ctx);
            const result = await connection.client.callTool(
              { name: tool.name, arguments: params as Record<string, unknown> },
              undefined,
              {
                signal,
                resetTimeoutOnProgress: true,
                onprogress: progress => {
                  const percent = progress.total && progress.total > 0 ? ` ${Math.round(progress.progress / progress.total * 100)}%` : "";
                  const progressMessage = sanitizeTerminalText(progress.message ?? `Calling ${displayToolName}`, { multiline: false, maxLength: 1024 });
                  const safeProgress = {
                    progress: Number.isFinite(progress.progress) ? progress.progress : 0,
                    total: Number.isFinite(progress.total) ? progress.total : undefined,
                    message: progressMessage,
                  };
                  onUpdate?.({ content: [{ type: "text", text: `${progressMessage}...${percent}` }], details: { server: displayServerName, tool: displayToolName, progress: safeProgress } });
                },
              },
            );
            if ("isError" in result && result.isError) throw new Error(formatToolResult(result));
            return { content: [{ type: "text", text: formatToolResult(result) }], details: { server: displayServerName, tool: displayToolName, scope: server.scope } };
          } catch (error) {
            throw new Error(getErrorMessage(error));
          }
        },
        renderCall: (args, theme, context) => this.renderer.render(server, displayToolName, args as Record<string, unknown>, theme, context as unknown as CompactMcpRenderContext),
        renderResult: (result, options, theme, context) => {
          const progress = (result.details as any)?.progress;
          if (options.isPartial && progress) {
            const percent = progress.total && progress.total > 0 ? `${Math.round(progress.progress / progress.total * 100)}%` : `${progress.progress}`;
            const progressMessage = progress.message ? sanitizeTerminalText(progress.message, { multiline: false, maxLength: 1024 }) : "";
            context.state.progressText = progressMessage ? `${percent} ${progressMessage}` : percent;
          }
          this.renderer.render(server, displayToolName, context.args as Record<string, unknown>, theme, context as unknown as CompactMcpRenderContext);
          return new Text("", 0, 0);
        },
      });
    }

    if ((server.resources?.length ?? 0) > 0) {
      const registeredName = allocateName("read_resource", "resource");
      const displayServerName = safeServerName(server);
      const resourceUris = server.resources!.map(resource => sanitizeTerminalText(resource.uri, { multiline: false, maxLength: 1024 }));
      this.pi.registerTool({
        name: registeredName,
        label: `${displayServerName}: Read Resource`,
        description: `Read an MCP resource from ${displayServerName}`,
        parameters: schemaToTypeBox({ type: "object", properties: { uri: { type: "string", description: `Resource URI. Available: ${resourceUris.join(", ")}` } }, required: ["uri"] }),
        renderShell: "self",
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          if (!server.enabled) throw new Error(`MCP server ${server.name} is disabled`);
          const displayUri = sanitizeTerminalText((params as any).uri, { multiline: false, maxLength: 2048 });
          onUpdate?.({ content: [{ type: "text", text: `Reading ${displayUri}...` }], details: { server: displayServerName, uri: displayUri } });
          try {
            const connection = await getConnection(server.name, ctx);
            const result = await connection.client.readResource({ uri: (params as any).uri }, { signal });
            const content = result.contents.map(item => "text" in item ? item.text : `[Binary resource: ${sanitizeTerminalText(item.mimeType ?? "unknown", { multiline: false })}]`);
            return { content: [{ type: "text", text: truncateRemoteOutput(content.join("\n")) }], details: { server: displayServerName, uri: displayUri, scope: server.scope } };
          } catch (error) {
            throw new Error(getErrorMessage(error));
          }
        },
        renderCall: (args, theme, context) => this.renderer.render(server, "read_resource", args as Record<string, unknown>, theme, context as unknown as CompactMcpRenderContext),
        renderResult: (_result, _options, theme, context) => {
          this.renderer.render(server, "read_resource", context.args as Record<string, unknown>, theme, context as unknown as CompactMcpRenderContext);
          return new Text("", 0, 0);
        },
      });
    }
    this.registeredToolNames.set(server.name, names);
    this.pi.setActiveTools([...new Set([...this.pi.getActiveTools(), ...names])]);
  }
}
