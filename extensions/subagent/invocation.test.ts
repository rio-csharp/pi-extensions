import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CHILD_THINKING, parseModelOverride, resolveChildInvocation } from "./invocation.ts";

interface FakeModel {
	provider: string;
	id: string;
}

const TOOLS = ["read", "grep", "edit", "write", "bash"];

function fakeContext(options: {
	models?: FakeModel[];
	authed?: string[];
	parent?: FakeModel;
	providerConfig?: Record<string, unknown>;
}): ExtensionContext {
	const models = options.models ?? [];
	const authed = new Set(options.authed ?? models.map((model) => `${model.provider}/${model.id}`));
	const context = {
		model: options.parent,
		modelRegistry: {
			find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
			getAll: () => models,
			hasConfiguredAuth: (model: FakeModel) => authed.has(`${model.provider}/${model.id}`),
			getRegisteredProviderConfig: (provider: string) => options.providerConfig?.[provider],
		},
	};
	return context as unknown as ExtensionContext;
}

const parentModel: FakeModel = { provider: "qfg", id: "claude-opus-5.5" };

const relayContext = () =>
	fakeContext({
		models: [
			parentModel,
			{ provider: "deepseek", id: "deepseek-v4.1-flash" },
			{ provider: "amr-link", id: "deepseek-v4.1-flash" },
		],
		parent: parentModel,
		providerConfig: {
			qfg: { apiKey: "${QFG_API_KEY}" },
			"amr-link": { apiKey: "${AMR_LINK_API_KEY}" },
		},
	});

test("parseModelOverride splits a valid thinking suffix", () => {
	assert.deepEqual(parseModelOverride("qfg/claude-opus-5.5:high"), { model: "qfg/claude-opus-5.5", thinking: "high" });
	assert.deepEqual(parseModelOverride(" deepseek-v4.1-flash:low "), { model: "deepseek-v4.1-flash", thinking: "low" });
	assert.deepEqual(parseModelOverride("off"), { model: "off" });
});

test("parseModelOverride keeps non-thinking colons inside the model id", () => {
	assert.deepEqual(parseModelOverride("openrouter/moonshotai/kimi-k2:free"), { model: "openrouter/moonshotai/kimi-k2:free" });
	assert.deepEqual(parseModelOverride(":high"), { model: ":high" });
});

test("resolveChildInvocation keeps the parent model when no override is given", () => {
	const invocation = resolveChildInvocation(relayContext(), {}, TOOLS);
	assert.equal(invocation.model, undefined);
	assert.equal(invocation.provider, "qfg");
	assert.deepEqual(invocation.providerEnvNames, ["QFG_API_KEY"]);
	assert.equal(invocation.thinking, DEFAULT_CHILD_THINKING);
	assert.equal(invocation.thinking, "medium");
	assert.equal(invocation.tools, undefined);
});

test("resolveChildInvocation resolves a bare model id", () => {
	const invocation = resolveChildInvocation(fakeContext({
		models: [parentModel, { provider: "deepseek", id: "deepseek-v4.1-flash" }],
		parent: parentModel,
	}), { model: "deepseek-v4.1-flash" }, TOOLS);
	assert.equal(invocation.model, "deepseek/deepseek-v4.1-flash");
	assert.equal(invocation.provider, "deepseek");
});

test("resolveChildInvocation resolves provider/id and uses that provider's env", () => {
	const invocation = resolveChildInvocation(relayContext(), { model: "amr-link/deepseek-v4.1-flash" }, TOOLS);
	assert.equal(invocation.model, "amr-link/deepseek-v4.1-flash");
	assert.equal(invocation.provider, "amr-link");
	assert.deepEqual(invocation.providerEnvNames, ["AMR_LINK_API_KEY"]);
});

test("resolveChildInvocation prefers the provider with configured auth for a bare id", () => {
	const invocation = resolveChildInvocation(
		fakeContext({
			models: [parentModel, { provider: "deepseek", id: "deepseek-v4.1-flash" }, { provider: "amr-link", id: "deepseek-v4.1-flash" }],
			authed: ["qfg/claude-opus-5.5", "amr-link/deepseek-v4.1-flash"],
			parent: parentModel,
		}),
		{ model: "deepseek-v4.1-flash" },
		TOOLS,
	);
	assert.equal(invocation.model, "amr-link/deepseek-v4.1-flash");
	assert.equal(invocation.provider, "amr-link");
});

test("resolveChildInvocation parses the model suffix and lets thinking win over it", () => {
	const suffix = resolveChildInvocation(relayContext(), { model: "qfg/claude-opus-5.5:high" }, TOOLS);
	assert.equal(suffix.model, "qfg/claude-opus-5.5");
	assert.equal(suffix.thinking, "high");

	const explicit = resolveChildInvocation(relayContext(), { model: "qfg/claude-opus-5.5:high", thinking: "max" }, TOOLS);
	assert.equal(explicit.thinking, "max");

	const inherited = resolveChildInvocation(relayContext(), { thinking: "minimal" }, TOOLS);
	assert.equal(inherited.model, undefined);
	assert.equal(inherited.thinking, "minimal");
});

test("resolveChildInvocation throws on an invalid thinking level", () => {
	assert.throws(
		() => resolveChildInvocation(relayContext(), { thinking: "extreme" }, TOOLS),
		/Invalid thinking level "extreme"; valid values: off, minimal, low, medium, high, xhigh, max\./,
	);
	assert.throws(
		() => resolveChildInvocation(relayContext(), { thinking: "extreme" }, TOOLS),
		/An explicit override that cannot be honored is a hard failure/,
	);
});

test("resolveChildInvocation throws on an unknown bare model and names the parent model to inherit", () => {
	assert.throws(
		() => resolveChildInvocation(relayContext(), { model: "ghost-model" }, TOOLS),
		/Model override "ghost-model" was not found in the model registry/,
	);
	assert.throws(
		() => resolveChildInvocation(relayContext(), { model: "ghost-model" }, TOOLS),
		/omit "model" to inherit qfg\/claude-opus-5\.5/,
	);
});

test("resolveChildInvocation suggests real candidates when the provider prefix is wrong", () => {
	assert.throws(
		() => resolveChildInvocation(fakeContext({
			models: [parentModel, { provider: "amr-link", id: "deepseek-v4.1-flash" }],
			parent: parentModel,
		}), { model: "nope/ghost-model:high" }, TOOLS),
		/Candidates: qfg\/claude-opus-5\.5, amr-link\/deepseek-v4\.1-flash/,
	);
});

test("resolveChildInvocation throws when the target provider has no configured auth", () => {
	assert.throws(
		() => resolveChildInvocation(
			fakeContext({
				models: [parentModel, { provider: "ai-pixel", id: "relay-model" }],
				authed: ["qfg/claude-opus-5.5"],
				parent: parentModel,
				providerConfig: { "ai-pixel": { apiKey: "${AI_PIXEL_API_KEY}" }, qfg: { apiKey: "${QFG_API_KEY}" } },
			}),
			{ model: "ai-pixel/relay-model" },
			TOOLS,
		),
		/no configured credentials for provider "ai-pixel"/,
	);
	assert.throws(
		() => resolveChildInvocation(
			fakeContext({
				models: [parentModel, { provider: "ai-pixel", id: "relay-model" }],
				authed: ["qfg/claude-opus-5.5"],
				parent: parentModel,
			}),
			{ model: "ai-pixel/relay-model" },
			TOOLS,
		),
		/omit "model" to inherit qfg\/claude-opus-5\.5/,
	);
});

test("resolveChildInvocation throws on an empty or whitespace-only model override", () => {
	assert.throws(() => resolveChildInvocation(relayContext(), { model: "" }, TOOLS), /Model override is empty/);
	assert.throws(() => resolveChildInvocation(relayContext(), { model: "   " }, TOOLS), /Model override is empty/);
	assert.throws(
		() => resolveChildInvocation(relayContext(), { model: "   " }, TOOLS),
		/omit "model" to inherit qfg\/claude-opus-5\.5/,
	);
});

test("resolveChildInvocation never resolves an explicit provider prefix to another provider", () => {
	const context = fakeContext({
		models: [parentModel, { provider: "amr-link", id: "deepseek-v4.1-flash" }],
		parent: parentModel,
	});

	assert.throws(
		() => resolveChildInvocation(context, { model: "qfg/deepseek-v4.1-flash" }, TOOLS),
		/Model override "qfg\/deepseek-v4\.1-flash" was not found for provider "qfg"/,
	);

	const bare = resolveChildInvocation(context, { model: "deepseek-v4.1-flash" }, TOOLS);
	assert.equal(bare.model, "amr-link/deepseek-v4.1-flash");
	assert.equal(bare.provider, "amr-link");
});

test("resolveChildInvocation keeps valid tools and an empty list means inherit", () => {
	const invocation = resolveChildInvocation(relayContext(), { tools: ["read", "grep"] }, TOOLS);
	assert.deepEqual(invocation.tools, ["read", "grep"]);

	const adjusted = resolveChildInvocation(relayContext(), { tools: ["+edit", "-write"] }, TOOLS);
	assert.deepEqual(adjusted.tools, ["+edit", "-write"]);

	const patterned = resolveChildInvocation(relayContext(), { tools: ["read", "mcp_*"] }, TOOLS);
	assert.deepEqual(patterned.tools, ["read", "mcp_*"]);

	const empty = resolveChildInvocation(relayContext(), { tools: [] }, TOOLS);
	assert.equal(empty.tools, undefined);
});

test("resolveChildInvocation throws on malformed tools entries", () => {
	assert.throws(
		() => resolveChildInvocation(relayContext(), { tools: ["ba d", "", "a,b"] }, TOOLS),
		/Invalid tools entries: "ba d", "", "a,b"/,
	);
	assert.throws(
		() => resolveChildInvocation(relayContext(), { tools: ["x".repeat(129)] }, TOOLS),
		/at most 128 characters/,
	);
});

test("resolveChildInvocation rejects mixing plain tool names with +name/-name entries", () => {
	assert.throws(
		() => resolveChildInvocation(relayContext(), { tools: ["read", "+edit"] }, TOOLS),
		/tool names cannot be mixed with \+name or -name entries/,
	);
});

test("resolveChildInvocation throws on an unknown tool name and lists the real ones", () => {
	assert.throws(
		() => resolveChildInvocation(relayContext(), { tools: ["read", "reed"] }, TOOLS),
		/Unknown tools entries: "reed"; available tools: read, grep, edit, write, bash\./,
	);
	assert.throws(
		() => resolveChildInvocation(relayContext(), { tools: ["+nope"] }, TOOLS),
		/Unknown tools entries: "nope"/,
	);
});

test("resolveChildInvocation rejects wildcards inside +name/-name entries", () => {
	assert.throws(
		() => resolveChildInvocation(relayContext(), { tools: ["+*"] }, TOOLS),
		/wildcards are only allowed for plain tool names/,
	);
});

test("resolveChildInvocation trims the extra system prompt", () => {
	const invocation = resolveChildInvocation(relayContext(), { systemPrompt: "  Prefer pnpm.  " }, TOOLS);
	assert.equal(invocation.systemPrompt, "Prefer pnpm.");

	const blank = resolveChildInvocation(relayContext(), { systemPrompt: "   " }, TOOLS);
	assert.equal(blank.systemPrompt, undefined);
});
