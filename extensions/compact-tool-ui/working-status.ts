import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WORKING_TICK_MS = 250;
const INITIAL_STAGE = "Preparing model request";

function formatElapsed(milliseconds: number): string {
	if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
	return `${(milliseconds / 1000).toFixed(1)}s`;
}

export function registerWorkingStatus(pi: ExtensionAPI): void {
	let ticker: ReturnType<typeof setInterval> | undefined;
	let currentContext: ExtensionContext | undefined;
	let agentRunning = false;
	let stage = INITIAL_STAGE;
	let stageStartedAt = Date.now();
	const activeToolIds = new Set<string>();

	const updateMessage = () => {
		if (!agentRunning || activeToolIds.size > 0 || !currentContext) return;
		const elapsed = formatElapsed(Date.now() - stageStartedAt);
		currentContext.ui.setWorkingMessage(`${stage} · ${elapsed} · Esc to interrupt`);
	};

	const setStage = (label: string, ctx?: ExtensionContext) => {
		if (ctx) currentContext = ctx;
		if (stage !== label) {
			stage = label;
			stageStartedAt = Date.now();
		}
		updateMessage();
	};

	const startTicker = () => {
		if (ticker) return;
		ticker = setInterval(updateMessage, WORKING_TICK_MS);
		ticker.unref?.();
	};

	const stopTicker = () => {
		if (!ticker) return;
		clearInterval(ticker);
		ticker = undefined;
	};

	const finishAgent = (ctx: ExtensionContext) => {
		agentRunning = false;
		activeToolIds.clear();
		stopTicker();
		ctx.ui.setWorkingVisible(true);
		ctx.ui.setWorkingMessage();
	};

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		agentRunning = false;
		activeToolIds.clear();
		ctx.ui.setWorkingVisible(true);
		ctx.ui.setWorkingMessage();
	});

	pi.on("agent_start", (_event, ctx) => {
		currentContext = ctx;
		agentRunning = true;
		activeToolIds.clear();
		ctx.ui.setWorkingVisible(true);
		stage = INITIAL_STAGE;
		stageStartedAt = Date.now();
		startTicker();
		updateMessage();
	});

	pi.on("context", (_event, ctx) => {
		setStage("Preparing conversation context", ctx);
	});

	pi.on("before_provider_request", (_event, ctx) => {
		setStage("Requesting model", ctx);
	});

	pi.on("after_provider_response", (_event, ctx) => {
		setStage("Receiving model response", ctx);
	});

	pi.on("message_update", (event, ctx) => {
		if (event.message.role !== "assistant") return;

		switch (event.assistantMessageEvent.type) {
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
				setStage("Generating reasoning", ctx);
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
				setStage("Generating response", ctx);
				break;

			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end": {
				const names = [
					...new Set(
						event.message.content.flatMap((item) =>
							item.type === "toolCall" && item.name ? [item.name] : [],
						),
					),
				];
				setStage(`Preparing tool call${names.length ? `: ${names.join(", ")}` : ""}`, ctx);
				break;
			}
		}
	});

	pi.on("tool_execution_start", (event, ctx) => {
		currentContext = ctx;
		activeToolIds.add(event.toolCallId);
		ctx.ui.setWorkingVisible(false);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		currentContext = ctx;
		activeToolIds.delete(event.toolCallId);
		if (activeToolIds.size === 0 && agentRunning) {
			ctx.ui.setWorkingVisible(true);
			setStage("Tool completed; waiting for model", ctx);
		}
	});

	pi.on("agent_end", (_event, ctx) => finishAgent(ctx));
	pi.on("agent_settled", (_event, ctx) => finishAgent(ctx));

	pi.on("session_shutdown", () => {
		stopTicker();
		activeToolIds.clear();
		currentContext = undefined;
	});
}
