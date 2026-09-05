
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function isPathWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function canonicalExistingPath(candidate: string): string | null {
	try {
		return fs.realpathSync.native(candidate);
	} catch {
		return null;
	}
}

function loadAgentsFromDir(dir: string, source: "user" | "project", boundary: string): AgentConfig[] {
	const agents: AgentConfig[] = [];
	const canonicalDir = canonicalExistingPath(dir);
	const canonicalBoundary = canonicalExistingPath(boundary);
	if (!canonicalDir || !canonicalBoundary || !isPathWithin(canonicalBoundary, canonicalDir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(canonicalDir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(canonicalDir, entry.name);
		const canonicalFile = canonicalExistingPath(filePath);
		if (!canonicalFile || !isPathWithin(canonicalDir, canonicalFile)) continue;
		let content: string;
		try {
			if (!fs.statSync(canonicalFile).isFile()) continue;
			content = fs.readFileSync(canonicalFile, "utf-8");
		} catch {
			continue;
		}

		let parsed: { frontmatter: Record<string, unknown>; body: string };
		try {
			parsed = parseFrontmatter<Record<string, unknown>>(content);
		} catch {
			continue;
		}
		const { frontmatter, body } = parsed;
		if (
			typeof frontmatter.name !== "string"
			|| !frontmatter.name.trim()
			|| typeof frontmatter.description !== "string"
			|| !frontmatter.description.trim()
			|| (frontmatter.model !== undefined && typeof frontmatter.model !== "string")
		) continue;

		let tools: string[] | undefined;
		if (typeof frontmatter.tools === "string") {
			tools = frontmatter.tools.split(",").map((tool) => tool.trim()).filter(Boolean);
		} else if (Array.isArray(frontmatter.tools) && frontmatter.tools.every((tool) => typeof tool === "string")) {
			tools = frontmatter.tools.map((tool) => tool.trim()).filter(Boolean);
		} else if (frontmatter.tools !== undefined) {
			continue;
		}

		agents.push({
			name: frontmatter.name.trim(),
			description: frontmatter.description.trim(),
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model || undefined,
			systemPrompt: body,
			source,
			filePath: canonicalFile,
		});
	}

	return agents;
}

function findProjectAgentsDir(cwd: string, projectBoundary: string | undefined): string | null {
	const canonicalCwd = canonicalExistingPath(cwd);
	if (!canonicalCwd) return null;
	const requestedBoundary = projectBoundary ? canonicalExistingPath(projectBoundary) : null;
	const canonicalBoundary = requestedBoundary && isPathWithin(requestedBoundary, canonicalCwd)
		? requestedBoundary
		: canonicalCwd;

	let current = canonicalCwd;
	while (isPathWithin(canonicalBoundary, current)) {
		const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
		const canonicalCandidate = canonicalExistingPath(candidate);
		if (canonicalCandidate && isPathWithin(current, canonicalCandidate)) {
			try {
				if (fs.statSync(canonicalCandidate).isDirectory()) return canonicalCandidate;
			} catch {
			}
		}
		if (current === canonicalBoundary) break;
		const parent = path.dirname(current);
		if (parent === current || !isPathWithin(canonicalBoundary, parent)) break;
		current = parent;
	}
	return null;
}

export function discoverAgents(cwd: string, scope: AgentScope, projectBoundary?: string): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findProjectAgentsDir(cwd, projectBoundary);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user", userDir);
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project", projectAgentsDir);

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
