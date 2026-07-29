const BIDI_CONTROLS = new Set([
	0x061c, 0x200e, 0x200f,
	...Array.from({ length: 5 }, (_, index) => 0x202a + index),
	...Array.from({ length: 10 }, (_, index) => 0x2066 + index),
]);

function isControlStringStart(codePoint: number): boolean {
	return codePoint === 0x90 || codePoint === 0x98 || codePoint === 0x9d || codePoint === 0x9e || codePoint === 0x9f;
}

/** Remove ANSI/OSC/C0/C1 and bidi-spoofing controls from untrusted display text. */
export function terminalSanitize(value: string): string {
	let output = "";
	for (let index = 0; index < value.length;) {
		const codePoint = value.codePointAt(index)!;
		const width = codePoint > 0xffff ? 2 : 1;

		// ESC ]/P/X/^/_ and their C1 forms introduce terminal control strings.
		if (codePoint === 0x1b && index + 1 < value.length && "]PX^_".includes(value[index + 1])) {
			index += 2;
			while (index < value.length) {
				const current = value.codePointAt(index)!;
				if (current === 0x07 || current === 0x9c) {
					index += 1;
					break;
				}
				if (current === 0x1b && value[index + 1] === "\\") {
					index += 2;
					break;
				}
				index += current > 0xffff ? 2 : 1;
			}
			continue;
		}
		if (isControlStringStart(codePoint)) {
			index += width;
			while (index < value.length) {
				const current = value.codePointAt(index)!;
				if (current === 0x07 || current === 0x9c) {
					index += 1;
					break;
				}
				if (current === 0x1b && value[index + 1] === "\\") {
					index += 2;
					break;
				}
				index += current > 0xffff ? 2 : 1;
			}
			continue;
		}

		// CSI (ESC [ or C1 CSI): consume parameters/intermediates through final byte.
		if ((codePoint === 0x1b && value[index + 1] === "[") || codePoint === 0x9b) {
			index += codePoint === 0x1b ? 2 : 1;
			while (index < value.length) {
				const current = value.charCodeAt(index++);
				if (current >= 0x40 && current <= 0x7e) break;
			}
			continue;
		}

		// Other two-byte/intermediate ANSI escape sequences.
		if (codePoint === 0x1b) {
			index += 1;
			while (index < value.length) {
				const current = value.charCodeAt(index++);
				if (current >= 0x30 && current <= 0x7e) break;
			}
			continue;
		}

		if (BIDI_CONTROLS.has(codePoint)) {
			index += width;
			continue;
		}
		if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
			output += " ";
			index += width;
			continue;
		}
		output += String.fromCodePoint(codePoint);
		index += width;
	}
	return output.replace(/ +/g, " ");
}

/** A terminal-safe, reversible representation suitable for an exact-path confirmation. */
export function quoteExactPath(value: string): string {
	let quoted = '"';
	for (const char of value) {
		const codePoint = char.codePointAt(0)!;
		if (char === '"') quoted += '\\"';
		else if (char === "\\") quoted += "\\\\";
		else if (
			codePoint <= 0x1f ||
			(codePoint >= 0x7f && codePoint <= 0x9f) ||
			BIDI_CONTROLS.has(codePoint)
		) quoted += `\\u{${codePoint.toString(16).padStart(4, "0")}}`;
		else quoted += char;
	}
	return `${quoted}"`;
}

const BASE_ENV_NAMES = new Set([
	// Process launch, OS account/directories, locale, TLS, and JS runtime.
	"PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
	"HOME", "USER", "USERNAME", "LOGNAME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
	"APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
	"COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "OS", "SHELL", "TERM", "COLORTERM",
	"PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "NUMBER_OF_PROCESSORS",
	"LANG", "TZ", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
	"SSL_CERT_FILE", "SSL_CERT_DIR", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "NODE_OPTIONS", "NODE_PATH",
	"NODE_EXTRA_CA_CERTS", "UV_THREADPOOL_SIZE", "BUN_INSTALL",

	// Pi process configuration. Parent session/model metadata is intentionally absent.
	"PI_CODING_AGENT", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_PACKAGE_DIR",
	"PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "PI_CACHE_RETENTION",
	"PI_SHARE_VIEWER_URL", "PI_HARDWARE_CURSOR", "PI_CLEAR_ON_SHRINK", "PI_EXPERIMENTAL",

	// Network transport used by Pi/provider SDKs.
	"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
]);

const PROVIDER_ENV_NAMES: Record<string, readonly string[]> = {
	anthropic: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
	"ant-ling": ["ANT_LING_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	"azure-openai-responses": ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME", "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP"],
	deepseek: ["DEEPSEEK_API_KEY"], nvidia: ["NVIDIA_API_KEY"], google: ["GEMINI_API_KEY"],
	"google-vertex": ["GOOGLE_CLOUD_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "CLOUDSDK_CONFIG"],
	groq: ["GROQ_API_KEY"], cerebras: ["CEREBRAS_API_KEY"], xai: ["XAI_API_KEY"], radius: ["RADIUS_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"], "openrouter-images": ["OPENROUTER_API_KEY"],
	"vercel-ai-gateway": ["AI_GATEWAY_API_KEY"], zai: ["ZAI_API_KEY"], "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
	mistral: ["MISTRAL_API_KEY"], minimax: ["MINIMAX_API_KEY"], "minimax-cn": ["MINIMAX_CN_API_KEY"],
	moonshotai: ["MOONSHOT_API_KEY"], "moonshotai-cn": ["MOONSHOT_API_KEY"], huggingface: ["HF_TOKEN"],
	fireworks: ["FIREWORKS_API_KEY"], together: ["TOGETHER_API_KEY"], opencode: ["OPENCODE_API_KEY"],
	"opencode-go": ["OPENCODE_API_KEY"], "kimi-coding": ["KIMI_API_KEY"],
	"cloudflare-workers-ai": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"],
	"cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"],
	"qwen-token-plan": ["QWEN_TOKEN_PLAN_API_KEY"], "qwen-token-plan-cn": ["QWEN_TOKEN_PLAN_CN_API_KEY"],
	xiaomi: ["XIAOMI_API_KEY"], "xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
	"xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"], "xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
	"github-copilot": ["COPILOT_GITHUB_TOKEN"],
	"amazon-bedrock": [
		"AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK",
		"AWS_REGION", "AWS_DEFAULT_REGION", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_SDK_LOAD_CONFIG",
		"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN",
		"AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_ROLE_SESSION_NAME",
		"AWS_EC2_METADATA_DISABLED", "AWS_STS_REGIONAL_ENDPOINTS", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
		"AWS_BEDROCK_SKIP_AUTH", "AWS_BEDROCK_FORCE_HTTP1", "AWS_BEDROCK_FORCE_CACHE",
	],
};

const CUSTOM_PROVIDER_SUFFIXES = [
	"API_KEY", "AUTH_TOKEN", "OAUTH_TOKEN", "BASE_URL", "ENDPOINT", "ACCOUNT_ID", "GATEWAY_ID",
	"PROJECT", "LOCATION", "REGION",
];

function providerEnvPrefix(provider: string | undefined): string | undefined {
	if (!provider) return undefined;
	const prefix = provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return prefix || undefined;
}

function allowedProviderNames(provider: string | undefined): Set<string> {
	if (!provider) return new Set();
	const configured = PROVIDER_ENV_NAMES[provider.toLowerCase()];
	if (configured) return new Set(configured);
	const prefix = providerEnvPrefix(provider);
	return new Set(prefix ? CUSTOM_PROVIDER_SUFFIXES.map((suffix) => `${prefix}_${suffix}`) : []);
}

export function referencedEnvironmentNames(value: unknown): string[] {
	const names = new Set<string>();
	const visit = (candidate: unknown): void => {
		if (typeof candidate === "string") {
			const pattern = /(?<!\$)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
			for (const match of candidate.matchAll(pattern)) names.add(match[1] ?? match[2]);
			return;
		}
		if (Array.isArray(candidate)) {
			for (const item of candidate) visit(item);
			return;
		}
		if (candidate && typeof candidate === "object") {
			for (const item of Object.values(candidate)) visit(item);
		}
	};
	visit(value);
	return [...names];
}

/** Construct the deliberately small environment inherited by a child Pi. */
export function buildChildEnvironment(
	source: NodeJS.ProcessEnv = process.env,
	provider?: string,
	additionalProviderNames: readonly string[] = [],
): NodeJS.ProcessEnv {
	const child: NodeJS.ProcessEnv = {};
	const providerNames = allowedProviderNames(provider);
	for (const name of additionalProviderNames) providerNames.add(name.toUpperCase());
	for (const [name, value] of Object.entries(source)) {
		if (value === undefined) continue;
		const upper = name.toUpperCase();
		if (upper.startsWith("PI_SESSION_") || upper === "PI_PROVIDER" || upper === "PI_MODEL" || upper === "PI_REASONING_LEVEL") continue;
		if (BASE_ENV_NAMES.has(upper) || upper.startsWith("LC_") || providerNames.has(upper)) child[name] = value;
	}
	return child;
}
