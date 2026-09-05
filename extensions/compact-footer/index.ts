import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

const INLINE_STATUS_KEYS = new Set(["relay-balance", "kimi-usage"]);
const DEDICATED_ROW_PREFIX = "footer-row-";
const MAX_LABEL_LENGTH = 48;

function stripTerminalStrings(value: string): string {
	return value
		.replace(/(?:\x1B\]|\x9D)[\s\S]*?(?:\x07|\x1B\\|\x9C|$)/g, "")
		.replace(/(?:\x1B[P_X^]|[\x90\x98\x9E\x9F])[\s\S]*?(?:\x1B\\|\x9C|$)/g, "");
}

function sanitizeExternalText(value: string, maxLength: number): string {
	const withoutSequences = stripTerminalStrings(value)
		.replace(/(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/(?:\x1B\[|\x9B)[0-?]*[ -/]*$/g, "")
		.replace(/\x1B[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1F\x7F-\x9F]/g, " ")
		.replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u206F]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return Array.from(withoutSequences).slice(0, maxLength).join("");
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

// Statuses can contain network/extension text: keep only pi theme SGR codes, sanitize every plain segment.
function sanitizeStatusText(text: string): string {
	const sgr = /\x1B\[[0-9;]*m/g;
	let result = "";
	let offset = 0;
	for (const match of text.matchAll(sgr)) {
		result += sanitizeExternalText(text.slice(offset, match.index), Number.MAX_SAFE_INTEGER);
		result += match[0];
		offset = (match.index ?? 0) + match[0].length;
	}
	result += sanitizeExternalText(text.slice(offset), Number.MAX_SAFE_INTEGER);
	return result.trim();
}

function installBalanceFooter(ctx: ExtensionContext): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsub = footerData.onBranchChange(() => tui.requestRender());
		return {
			dispose: unsub,
			invalidate() {},
			render(width: number): string[] {
				const model = ctx.model;

				const contextUsage = ctx.getContextUsage();
				const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
				const reportedContextPercent = contextUsage?.percent;
				// After compaction the provider can briefly report the pre-compaction prompt; treat impossible values as unknown.
				const contextPercentIsValid =
					reportedContextPercent !== null &&
					reportedContextPercent !== undefined &&
					Number.isFinite(reportedContextPercent) &&
					reportedContextPercent >= 0 &&
					reportedContextPercent <= 100;
				const contextPercentValue = contextPercentIsValid ? reportedContextPercent : 0;
				const contextPercent = contextPercentIsValid ? reportedContextPercent.toFixed(1) : "?";

				let pwd = formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
				const branch = footerData.getGitBranch();
				if (branch) pwd = `${pwd} (${branch})`;
				const sessionName = ctx.sessionManager.getSessionName();
				if (sessionName) pwd = `${pwd} • ${sessionName}`;

				const contextPercentDisplay = contextPercent === "?"
					? `?/${formatTokens(contextWindow)}`
					: `${contextPercent}%/${formatTokens(contextWindow)}`;
				let contextPercentStr: string;
				if (contextPercentValue > 90) contextPercentStr = theme.fg("error", contextPercentDisplay);
				else if (contextPercentValue > 70) contextPercentStr = theme.fg("warning", contextPercentDisplay);
				else contextPercentStr = contextPercentDisplay;

				const leftParts = [pwd, contextPercentStr];
				const extensionStatuses = footerData.getExtensionStatuses();
				for (const key of INLINE_STATUS_KEYS) {
					const statusText = extensionStatuses.get(key);
					if (statusText) leftParts.push(sanitizeStatusText(statusText));
				}

				let statsLeft = leftParts.join(" · ");
				const modelName = model ? sanitizeExternalText(model.id, 96) || "unnamed-model" : "no-model";
				let statsLeftWidth = visibleWidth(statsLeft);
				if (statsLeftWidth > width) {
					statsLeft = truncateToWidth(statsLeft, width, "...");
					statsLeftWidth = visibleWidth(statsLeft);
				}

				const minPadding = 2;
				let rightSideWithoutProvider = modelName;
				if (model?.reasoning) {
					const thinkingLevel = ctx.thinkingLevel || "off";
					rightSideWithoutProvider =
						thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
				}

				let rightSide = rightSideWithoutProvider;
				if (footerData.getAvailableProviderCount() > 1 && model) {
					const providerName = sanitizeExternalText(model.provider, MAX_LABEL_LENGTH) || "unknown-provider";
					rightSide = `(${providerName}) ${rightSideWithoutProvider}`;
					if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
						rightSide = rightSideWithoutProvider;
					}
				}

				const rightSideWidth = visibleWidth(rightSide);
				const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
				let statsLine: string;
				if (totalNeeded <= width) {
					const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
					statsLine = statsLeft + padding + rightSide;
				} else {
					const availableForRight = width - statsLeftWidth - minPadding;
					if (availableForRight > 0) {
						const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
						const truncatedRightWidth = visibleWidth(truncatedRight);
						const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
						statsLine = statsLeft + padding + truncatedRight;
					} else {
						statsLine = statsLeft;
					}
				}

				// Dim plain segments only, so the context-percentage colors survive.
				const dimStatsLeft = theme.fg("dim", statsLeft);
				const remainder = statsLine.slice(statsLeft.length);
				const dimRemainder = theme.fg("dim", remainder);
				const lines = [dimStatsLeft + dimRemainder];

				const statusEntries = Array.from(extensionStatuses.entries())
					.filter(([key]) => !INLINE_STATUS_KEYS.has(key))
					.sort(([a], [b]) => a.localeCompare(b));
				const otherStatuses = statusEntries
					.filter(([key]) => !key.startsWith(DEDICATED_ROW_PREFIX))
					.map(([, text]) => sanitizeStatusText(text));
				if (otherStatuses.length > 0) {
					lines.push(truncateToWidth(otherStatuses.join(" "), width, theme.fg("dim", "...")));
				}
				for (const [, text] of statusEntries.filter(([key]) => key.startsWith(DEDICATED_ROW_PREFIX))) {
					lines.push(truncateToWidth(sanitizeStatusText(text), width, theme.fg("dim", "...")));
				}

				return lines;
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	let footerInstalled = false;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		installBalanceFooter(ctx);
		footerInstalled = true;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (footerInstalled && ctx.hasUI) {
			ctx.ui.setFooter(undefined);
			footerInstalled = false;
		}
	});
}
