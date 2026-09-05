import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { McpRuntime } from "./runtime.js";

export {
  getErrorMessage,
  isStrictLoopbackUrl,
  parseMcpUrl,
  parseSafeHttpUrl,
  safeFetch,
  sanitizeTerminalText,
} from "./security.js";
export { disambiguateToolName, normalizedMcpToolName, schemaToTypeBox } from "./tools.js";

export default function mcpExtension(pi: ExtensionAPI): void {
  new McpRuntime(pi).register();
}
