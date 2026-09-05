import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const AgentName = Type.Optional(
	Type.String({ minLength: 1, maxLength: 128, description: "Name of the agent to invoke. Omit to run with pi defaults (current model, default tools)." }),
);

const TaskItem = Type.Object({
	agent: AgentName,
	title: Type.String({ minLength: 1, maxLength: 160, description: "Concise status title chosen by the main agent" }),
	task: Type.String({ minLength: 1, maxLength: 200000, description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: AgentName,
	title: Type.String({ minLength: 1, maxLength: 160, description: "Concise status title chosen by the main agent" }),
	task: Type.String({ minLength: 1, maxLength: 200000, description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

export const SubagentParams = Type.Object({
	agent: AgentName,
	title: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: "Concise status title chosen by the main agent (single mode)" })),
	task: Type.Optional(Type.String({ minLength: 1, maxLength: 200000, description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent?, title, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent?, title, task} for sequential execution" })),
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
	action: StringEnum(["list", "status", "steer", "resume", "cancel"] as const, {
		description: "Supervisor action",
	}),
	jobId: Type.Optional(Type.String({ description: "Background job id; required except for list" })),
	taskIndex: Type.Optional(
		Type.Integer({ minimum: 0, description: "Zero-based task index for steer; optional when exactly one child is running" }),
	),
	instruction: Type.Optional(
		Type.String({ maxLength: 200000, description: "Steering message for a running child, or optional continuation instruction when resuming" }),
	),
	includeOutput: Type.Optional(
		Type.Boolean({
			description: "Opt in to bounded task output for status. Defaults to false; ignored by other actions.",
			default: false,
		}),
	),
});
