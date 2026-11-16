import type { Message } from "@earendil-works/pi-ai";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	provider?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

export type SubagentMode = "single" | "parallel" | "chain";
export type BackgroundJobStatus = "running" | "canceling" | "completed" | "failed" | "interrupted" | "canceled";

export type SubagentJobTaskState = "succeeded" | "failed" | "pending" | "running";

export interface SubagentJobTaskDetails {
	title: string;
	sessionId: string;
	attempts: number;
	completed: boolean;
	model?: string;
	state?: SubagentJobTaskState;
}

export interface SubagentDetails {
	mode: SubagentMode;
	results: SingleResult[];
	background?: boolean;
	jobId?: string;
	jobStatus?: BackgroundJobStatus;
	startedAt?: number;
	finishedAt?: number;
	tasks?: SubagentJobTaskDetails[];
}

export interface SubagentJobsDetails {
	jobs: SubagentDetails[];
}

export interface SubagentTimelineState {
	startedAt?: number;
	finishedAt?: number;
	startText?: import("@earendil-works/pi-tui").Text;
	resultText?: import("@earendil-works/pi-tui").Text;
}

export interface SubagentJobsRenderState {
	calledAt?: number;
	callText?: import("@earendil-works/pi-tui").Text;
	resultDetails?: SubagentJobsDetails;
	isError?: boolean;
}
