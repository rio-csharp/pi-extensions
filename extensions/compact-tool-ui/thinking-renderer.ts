import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

/** Matches the tool rows, so a collapsed thinking run reads like any other collapsible row. */
export const HIDDEN_THINKING_LABEL = "▸ thinking";

function latestThinkingLine(markdown: string, availableWidth: number): string {
	const lines = markdown
		.split(/\r\n|\r|\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const latest = lines.at(-1) ?? "";
	return truncateToWidth(latest, Math.max(1, availableWidth), "…");
}

export function registerThinkingRenderer(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setHiddenThinkingLabel(HIDDEN_THINKING_LABEL);
	});

	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant-thinking") return markdown;

		return latestThinkingLine(markdown, context.availableWidth);
	});
}
