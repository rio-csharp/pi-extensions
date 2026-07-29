import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAgents } from "./agents.ts";
import { buildChildEnvironment, quoteExactPath, referencedEnvironmentNames, terminalSanitize } from "./security.ts";

test("terminalSanitize removes ANSI, OSC, C0/C1, and bidi controls", () => {
	const value = "ok\u001b]2;spoof\u0007 red\u001b[31m X\u001b[0m\u009dhidden\u009c\u202e\u0000end";
	const sanitized = terminalSanitize(value);
	assert.equal(sanitized, "ok red X end");
	assert.doesNotMatch(sanitized, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u206f]/u);
});

test("quoteExactPath names hostile paths reversibly without terminal controls", () => {
	const quoted = quoteExactPath("a\u001b]2;x\u0007\u202e\\\"b");
	assert.doesNotMatch(quoted, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u206f]/u);
	assert.match(quoted, /\\u\{001b\}/);
	assert.match(quoted, /\\u\{0007\}/);
	assert.match(quoted, /\\u\{202e\}/);
	assert.match(quoted, /\\\\/);
	assert.match(quoted, /\\"/);
});

test("buildChildEnvironment keeps runtime and selected provider only", () => {
	const child = buildChildEnvironment({
		PATH: "/bin",
		HOME: "/home/test",
		OPENAI_API_KEY: "selected",
		ANTHROPIC_API_KEY: "unrelated-provider",
		MY_APP_SECRET: "unrelated",
		PI_SESSION_ID: "parent",
		PI_SESSION_FILE: "/secret/session.jsonl",
		PI_PROVIDER: "parent-provider",
		PI_MODEL: "parent-model",
		PI_REASONING_LEVEL: "high",
	}, "openai");
	assert.deepEqual(child, { PATH: "/bin", HOME: "/home/test", OPENAI_API_KEY: "selected" });
});

test("buildChildEnvironment supports selected custom-provider config references", () => {
	const referenced = referencedEnvironmentNames({ apiKey: "$RELAY_SECRET", headers: { tenant: "${RELAY_TENANT}" }, literal: "$$NOT_ENV" });
	assert.deepEqual(referenced, ["RELAY_SECRET", "RELAY_TENANT"]);
	assert.deepEqual(
		buildChildEnvironment(
			{ K12_API_KEY: "selected", K12_BASE_URL: "url", RELAY_SECRET: "secret", RELAY_TENANT: "tenant", OTHER_TOKEN: "drop" },
			"k12",
			referenced,
		),
		{ K12_API_KEY: "selected", K12_BASE_URL: "url", RELAY_SECRET: "secret", RELAY_TENANT: "tenant" },
	);
});

test("project agent discovery stays within its explicit boundary and ignores escaping symlinks", () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-security-"));
	try {
		const child = join(root, "child");
		const rootAgents = join(root, ".pi", "agents");
		const childAgents = join(child, ".pi", "agents");
		mkdirSync(rootAgents, { recursive: true });
		mkdirSync(childAgents, { recursive: true });
		writeFileSync(join(rootAgents, "upward.md"), "---\nname: upward\ndescription: must not load\n---\nroot");
		writeFileSync(join(childAgents, "inside.md"), "---\nname: inside\ndescription: load\n---\nchild");
		const outside = join(root, "outside.md");
		writeFileSync(outside, "---\nname: outside\ndescription: must not load\n---\noutside");
		try {
			symlinkSync(outside, join(childAgents, "escape.md"));
		} catch {
			// Windows may deny symlink creation; confinement is still covered where available.
		}

		const confined = discoverAgents(child, "project", child);
		assert.deepEqual(confined.agents.map((agent) => agent.name), ["inside"]);
		assert.equal(confined.projectAgentsDir, childAgents);

		rmSync(childAgents, { recursive: true, force: true });
		const boundedUpward = discoverAgents(child, "project", root);
		assert.deepEqual(boundedUpward.agents.map((agent) => agent.name), ["upward"]);
		assert.equal(boundedUpward.projectAgentsDir, rootAgents);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
