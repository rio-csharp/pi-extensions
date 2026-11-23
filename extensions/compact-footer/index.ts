import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

const INLINE_STATUS_KEYS = new Set(["relay-balance", "kimi-usage", "opendesign-usage", "tps"]);
const DEDICATED_ROW_PREFIX = "footer-row-";
const MAX_LABEL_LENGTH = 48;
const MARQUEE_TICK_MS = 500;
const MARQUEE_STEP = 3;
const MARQUEE_GAP = "   ";

/** Slide an overlong line through a fixed window so the whole title stays readable. */
export function marqueeWindow(line: string, width: number, offset: number): string {
	if (width <= 0) return "";
	if (visibleWidth(line) <= width) return line;
	const period = visibleWidth(`${line}${MARQUEE_GAP}`);
	if (period <= width) return line;
	const doubled = `${line}${MARQUEE_GAP}${line}${MARQUEE_GAP}`;
	const start = ((offset % period) + period) % period;
	return sliceByColumn(doubled, start, width, true);
}

// Zero width and not stripped by the sanitizers, so the producer marks where scrolling must stop.
const SCROLL_MARKER = "\u200B";

function renderScrollable(fixedHead: string, scrollable: string, fixedTail: string, width: number, offset: number, line: string) {
	const window = width - visibleWidth(fixedHead) - visibleWidth(fixedTail);
	if (window <= 0) {
		return { text: truncateToWidth(line.split(SCROLL_MARKER).join(""), width, ""), scrolling: false };
	}
	if (visibleWidth(scrollable) <= window) {
		return { text: `${fixedHead}${scrollable}${fixedTail}`, scrolling: false };
	}
	// A window boundary that falls inside a wide grapheme drops it, so pad back to the exact width;
	// otherwise the pinned tail would jitter one column left on those frames.
	const slice = marqueeWindow(scrollable, window, offset);
	const padding = " ".repeat(Math.max(0, window - visibleWidth(slice)));
	return { text: `${fixedHead}${slice}${padding}${fixedTail}`, scrolling: true };
}

/**
 * A single marker keeps the original convention (`scrolling head` + `fixed tail`). A pair marks
 * `fixed head` + `scrolling middle` + `fixed tail`, which also pins row numbers.
 */
export function renderDedicatedRow(
	line: string,
	width: number,
	offset: number,
): { text: string; scrolling: boolean } {
	const firstMarker = line.indexOf(SCROLL_MARKER);
	if (firstMarker === -1) {
		const scrolling = visibleWidth(line) > width;
		return { text: scrolling ? marqueeWindow(line, width, offset) : line, scrolling };
	}

	const afterFirst = line.slice(firstMarker + SCROLL_MARKER.length);
	const secondMarker = afterFirst.indexOf(SCROLL_MARKER);
	if (secondMarker === -1) {
		return renderScrollable("", line.slice(0, firstMarker), afterFirst, width, offset, line);
	}

	return renderScrollable(
		line.slice(0, firstMarker),
		afterFirst.slice(0, secondMarker),
		afterFirst.slice(secondMarker + SCROLL_MARKER.length),
		width,
		offset,
		line,
	);
}

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
		let marqueeTimer: ReturnType<typeof setInterval> | undefined;
		let marqueeOffset = 0;

		const startMarquee = () => {
			if (marqueeTimer) return;
			marqueeTimer = setInterval(() => {
				marqueeOffset += MARQUEE_STEP;
				tui.requestRender();
			}, MARQUEE_TICK_MS);
			marqueeTimer.unref?.();
		};

		const stopMarquee = () => {
			if (!marqueeTimer) return;
			clearInterval(marqueeTimer);
			marqueeTimer = undefined;
			marqueeOffset = 0;
		};

		return {
			dispose() {
				unsub();
				stopMarquee();
			},
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
				// Prefer the configured display name; the footer's purpose is readability, not the wire model id.
				const modelLabel = model?.name?.trim() || model?.id || "";
				const modelName = model ? sanitizeExternalText(modelLabel, 96) || "unnamed-model" : "no-model";
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
					// Prefer the provider's display name (e.g. "OpenDesign") over its internal id.
					const providerDisplayName = ctx.modelRegistry?.getProviderDisplayName(model.provider) || model.provider;
					const providerName = sanitizeExternalText(providerDisplayName, MAX_LABEL_LENGTH) || "unknown-provider";
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
				let scrolling = false;
				for (const [, text] of statusEntries.filter(([key]) => key.startsWith(DEDICATED_ROW_PREFIX))) {
					const rendered = renderDedicatedRow(sanitizeStatusText(text), width, marqueeOffset);
					if (rendered.scrolling) scrolling = true;
					lines.push(rendered.text);
				}
				if (scrolling) startMarquee();
				else stopMarquee();

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
