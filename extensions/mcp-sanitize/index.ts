import type { ExtensionAPI, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";

const MCP_TOOL_PREFIX = "mcp__";
const MCP_RESOURCE_TOOLS = new Set([
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
]);

function isMcpTool(name: string): boolean {
	return name.startsWith(MCP_TOOL_PREFIX) || MCP_RESOURCE_TOOLS.has(name);
}

// CSI, single-character ESC sequences, and OSC (terminated by BEL or ST).
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

/**
 * Removes sequences a remote MCP server could abuse: ANSI escape sequences,
 * terminal control characters, zero-width characters, and bidi overrides
 * (Trojan Source).
 * Newlines, carriage returns, and tabs are data, so they survive; the
 * renderers handle their display. No truncation: the built-in MCP support
 * already bounds model-facing output, and codemode scripts need full results.
 */
export function sanitizeText(value: string): string {
	let output = "";
	for (const character of value.replace(ANSI_PATTERN, "").normalize("NFC")) {
		const codePoint = character.codePointAt(0)!;
		if (
			(codePoint < 0x20 && character !== "\n" && character !== "\r" && character !== "\t") ||
			(codePoint >= 0x7f && codePoint <= 0x9f) ||
			(codePoint >= 0x200b && codePoint <= 0x200f) ||
			(codePoint >= 0x202a && codePoint <= 0x202e) ||
			(codePoint >= 0x2060 && codePoint <= 0x206f) ||
			codePoint === 0xfeff
		) {
			continue;
		}
		output += character;
	}
	return output;
}

function sanitizeValue(value: unknown): unknown {
	if (typeof value === "string") return sanitizeText(value);
	if (Array.isArray(value)) return value.map(sanitizeValue);
	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) result[key] = sanitizeValue(entry);
		return result;
	}
	return value;
}

export default function mcpSanitize(pi: ExtensionAPI): void {
	pi.on("tool_result", (event: ToolResultEvent): ToolResultEventResult | undefined => {
		if (!isMcpTool(event.toolName)) return undefined;
		const result: ToolResultEventResult = {
			content: event.content.map((block) =>
				block.type === "text" ? { ...block, text: sanitizeText(block.text) } : block,
			),
		};
		// Replacing content without structuredContent drops it, and codemode
		// scripts read structuredContent, so sanitize and return it too.
		if (event.structuredContent !== undefined) {
			result.structuredContent = sanitizeValue(event.structuredContent) as ToolResultEventResult["structuredContent"];
		}
		return result;
	});
}
