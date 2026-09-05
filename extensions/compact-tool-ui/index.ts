import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactBuiltInTools } from "./built-in-tools.ts";
import { registerThinkingRenderer } from "./thinking-renderer.ts";
import { registerWorkingStatus } from "./working-status.ts";

export default function compactToolUi(pi: ExtensionAPI) {
	registerCompactBuiltInTools(pi);
	registerThinkingRenderer(pi);
	registerWorkingStatus(pi);
}
