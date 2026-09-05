import type { Message } from "@earendil-works/pi-ai";
import { terminalSanitize } from "./security.ts";
import type { SingleResult } from "./types.ts";

export const PER_TASK_OUTPUT_CAP = 50 * 1024;
export const SUPERVISOR_MESSAGE_CAP = 50 * 1024;
export const STATUS_DETAIL_OUTPUT_CAP = 4 * 1024;
export const STATUS_DETAIL_TOTAL_CAP = 20 * 1024;
export const PERSISTED_TASK_OUTPUT_CAP = 50 * 1024;
export const RESULT_DIAGNOSTIC_CAP = 4 * 1024;
export const RESULT_DETAILS_DIAGNOSTIC_TOTAL_CAP = 20 * 1024;
export const RESULT_METADATA_FIELD_CAP = 512;

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		return msg.content
			.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

export function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

export function truncateUtf8(output: string, cap: number, suffixLabel: string): string {
	if (cap <= 0) return "";
	const bytes = Buffer.from(output, "utf8");
	if (bytes.byteLength <= cap) return output;

	const suffix = `\n\n[${suffixLabel}.]`;
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	if (suffixBytes >= cap) return Buffer.from(suffix, "utf8").subarray(0, cap).toString("utf8").replace(/\uFFFD$/, "");

	let prefix = bytes.subarray(0, cap - suffixBytes).toString("utf8").replace(/\uFFFD$/, "");
	while (Buffer.byteLength(prefix, "utf8") + suffixBytes > cap) prefix = prefix.slice(0, -1);
	return `${prefix}${suffix}`;
}

// Child stderr, task output, and supervisor notifications all carry untrusted text that may embed credentials.
export function redactSensitiveText(value: string): string {
	return value
		.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "<private key redacted>")
		.replace(/(\b(?:proxy-)?authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi, "$1<redacted>")
		.replace(
			/((?:["']?)(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|passwd|credential|cookie|signature)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
			"$1<redacted>",
		)
		.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, "<redacted>")
		.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<jwt redacted>")
		.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, "$1<credentials redacted>@");
}

export function sanitizeBounded(value: string | undefined, cap: number, suffixLabel: string): string {
	return truncateUtf8(terminalSanitize(redactSensitiveText(value ?? "")), cap, suffixLabel);
}

export function truncateTaskOutput(output: string): string {
	return sanitizeBounded(output, PER_TASK_OUTPUT_CAP, "Output truncated");
}

export function appendBounded(current: string, addition: string, cap: number, suffixLabel = "Diagnostic output truncated"): string {
	if (Buffer.byteLength(current, "utf8") >= cap) return current;
	return truncateUtf8(current + addition, cap, suffixLabel);
}

export function compactDiagnostic(value: string | undefined, maxChars = 240): string | undefined {
	const compact = value ? terminalSanitize(redactSensitiveText(value)).replace(/\s+/g, " ").trim() : undefined;
	if (!compact) return undefined;
	return compact.length > maxChars ? `${compact.slice(0, maxChars - 3)}...` : compact;
}

export function effectiveModel(provider: string | undefined, model: string | undefined): string | undefined {
	if (!model) return undefined;
	if (!provider || model.startsWith(`${provider}/`)) return model;
	return `${provider}/${model}`;
}

export function boundedMetadata(value: string, cap = RESULT_METADATA_FIELD_CAP): string {
	return sanitizeBounded(value, cap, "Metadata truncated").replace(/ +/g, " ").trim();
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatElapsed(milliseconds: number): string {
	if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
	const totalSeconds = Math.floor(milliseconds / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}m${seconds.toString().padStart(2, "0")}s`;
	return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

export function formatClock(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}
