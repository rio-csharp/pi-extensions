import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

input.on("line", (line) => {
	const { id, message } = JSON.parse(line);
	const task = message.slice("Task: ".length);
	if (task === "fail startup") {
		process.stderr.write("Requested model unavailable in child\n", () => process.exit(1));
		return;
	}
	emit({ type: "response", id, success: true, data: { disposition: task === "handled" ? "handled" : "started" } });
	if (task === "handled") return;
	if (task === "exit early") {
		input.close();
		process.stdin.destroy();
		return;
	}
	const text = task === "produce previous" ? "$& $$ $` $' {previous}" : task === "show cwd" ? process.cwd() : task;
	emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end" } });
	emit({ type: "agent_settled" });
});
