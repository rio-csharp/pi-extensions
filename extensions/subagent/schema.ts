import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	title: Type.String({ description: "Concise status title chosen by the main agent" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	title: Type.String({ description: "Concise status title chosen by the main agent" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

export const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	title: Type.Optional(Type.String({ description: "Concise status title chosen by the main agent (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	background: Type.Optional(
		Type.Boolean({
			description: "Run under the background supervisor and return immediately. Defaults to true.",
			default: true,
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export const SubagentJobsParams = Type.Object({
	action: StringEnum(["list", "status", "resume", "cancel"] as const, {
		description: "Supervisor action",
	}),
	jobId: Type.Optional(Type.String({ description: "Background job id; required except for list" })),
	instruction: Type.Optional(
		Type.String({ description: "Optional continuation instruction when resuming the persisted child session" }),
	),
	includeOutput: Type.Optional(
		Type.Boolean({
			description: "Opt in to bounded task output for status. Defaults to false; ignored by other actions.",
			default: false,
		}),
	),
});
