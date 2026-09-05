import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

function latestThinkingLine(markdown: string, availableWidth: number): string {
	const lines = markdown
		.split(/\r\n|\r|\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const latest = lines.at(-1) ?? "";
	return truncateToWidth(latest, Math.max(1, availableWidth), "…");
}

export function registerThinkingRenderer(pi: ExtensionAPI): void {
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant-thinking") return markdown;

		return latestThinkingLine(markdown, context.availableWidth);
	});
}
