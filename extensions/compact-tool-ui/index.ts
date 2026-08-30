import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactBuiltInTools } from "./built-in-tools.ts";
import { registerWorkingStatus } from "./working-status.ts";

/**
 * Compact Tool UI
 *
 * - Renders built-in tool calls as compact timestamped rows.
 * - Hides tool result bodies, including when Ctrl+O is used.
 * - Caps every invocation row at three display lines and reports shell output-line counts.
 * - Replaces the generic Working row with observable model/tool stages.
 */
export default function compactToolUi(pi: ExtensionAPI) {
	registerCompactBuiltInTools(pi);
	registerWorkingStatus(pi);
}
