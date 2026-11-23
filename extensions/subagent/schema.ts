import { Type, type TSchema } from "typebox";

// pi-ai's `StringEnum` now returns a `@earendil-works/pi-schema` schema, which typebox cannot infer
// through `Static`, so tool parameters build the same `{type: "string", enum}` shape locally.
function stringEnum<T extends readonly string[]>(
	values: T,
	options: { description?: string; default?: T[number] } = {},
) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: [...values],
		...(options.description ? { description: options.description } : {}),
		...(options.default !== undefined ? { default: options.default } : {}),
	} as TSchema);
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// Schema validates shape only. Length and emptiness are enforced in code, because pi formats a
// schema violation as "Validation failed…" plus the whole argument JSON, which floods the transcript.
const TitleString = Type.String({
	description: "Short 2-5 word status title; never prefix it with the tool name",
});

const ModelOverride = Type.Optional(
	Type.String({
		description: "Optional target model as provider/id or bare id, with an optional :thinkingLevel suffix. Prefer omitting this field to use the configured subagent default, or the parent model if no default is configured. A blank value uses the default.",
	}),
);

const ThinkingOverride = Type.Optional(
	stringEnum(THINKING_LEVELS, {
		description: "Thinking level for the child; works with the inherited parent model too. Defaults to medium.",
	}),
);

const ToolsOverride = Type.Optional(
	Type.Array(Type.String(), {
		description: "Child tool selection passed as --tools: plain names replace the selection, entries that are all +name/-name adjust the defaults. Defaults to the child's own tools.",
	}),
);

const SystemPromptOverride = Type.Optional(
	Type.String({
		description: "Extra instructions appended to the child's system prompt, after any agent prompt.",
	}),
);

const TaskString = Type.String({ description: "Task to delegate to the agent" });

const TaskItem = Type.Object({
	title: TitleString,
	task: TaskString,
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: ModelOverride,
	thinking: ThinkingOverride,
	tools: ToolsOverride,
	systemPrompt: SystemPromptOverride,
});

const ChainItem = Type.Object({
	title: TitleString,
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: ModelOverride,
	thinking: ThinkingOverride,
	tools: ToolsOverride,
	systemPrompt: SystemPromptOverride,
});

export const SubagentParams = Type.Object({
	title: Type.Optional(TitleString),
	task: Type.Optional(TaskString),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {title, task, cwd?, model?, thinking?, tools?, systemPrompt?} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {title, task, cwd?, model?, thinking?, tools?, systemPrompt?} for sequential execution" })),
	background: Type.Optional(
		Type.Boolean({
			description: "Run under the background supervisor and return immediately. Defaults to true.",
			default: true,
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	model: ModelOverride,
	thinking: ThinkingOverride,
	tools: ToolsOverride,
	systemPrompt: SystemPromptOverride,
});

export const SubagentJobsParams = Type.Object({
	action: stringEnum(["list", "status", "steer", "resume", "cancel"] as const, {
		description: "Supervisor action. Use model, thinking, and tools only with resume. For other actions, omit all three fields.",
	}),
	jobId: Type.Optional(Type.String({ description: "Background job id; required except for list" })),
	taskIndex: Type.Optional(
		Type.Integer({ minimum: 0, description: "Zero-based task index for steer; optional when exactly one child is running" }),
	),
	instruction: Type.Optional(
		Type.String({ description: "Steering message for a running child, or optional continuation instruction when resuming" }),
	),
	model: Type.Optional(
		Type.String({
			description: "Resume only. Omit on other actions and to keep the recorded model. Supply a provider/id or bare id with an optional :thinkingLevel suffix to replace it. A blank value keeps the recorded model.",
		}),
	),
	thinking: Type.Optional(
		stringEnum(THINKING_LEVELS, {
			description: "Resume only. Omit on other actions and to keep the recorded thinking level.",
		}),
	),
	tools: Type.Optional(
		Type.Array(Type.String(), {
			description: "Resume only. Omit on other actions and to keep the recorded tool selection. Plain names replace the selection. Entries that are all +name/-name adjust the defaults.",
		}),
	),
	includeOutput: Type.Optional(
		Type.Boolean({
			description: "Opt in to bounded task output for status. Defaults to false; ignored by other actions.",
			default: false,
		}),
	),
});
