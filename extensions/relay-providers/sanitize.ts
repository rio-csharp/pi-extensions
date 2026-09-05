
const API_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{12,}\b/g;

export function sanitizeTerminalText(value: string, maxLength: number): string {
	const withoutSequences = value
		.replace(/(?:\x1B\]|\x9D)[\s\S]*?(?:\x07|\x1B\\|\x9C)/g, "")
		.replace(/(?:\x1B[P_X^]|[\x90\x98\x9E\x9F])[\s\S]*?(?:\x1B\\|\x9C)/g, "")
		.replace(/(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1B[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1F\x7F-\x9F]/g, " ")
		.replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return Array.from(withoutSequences).slice(0, maxLength).join("");
}

// Relay error bodies can echo the caller's API key back; never let sk- tokens reach the UI.
export function redactRelayErrorText(value: string): string {
	return value.replace(API_KEY_PATTERN, "<redacted>");
}
