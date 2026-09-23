import type { ExtensionAPI, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";

interface PreviousModel {
	provider: string;
	modelId: string;
}

/**
 * Carry the active model over to the new session when the user runs `/new`.
 *
 * pi resolves the model for a fresh session from CLI args, the enabled-models
 * scope, or the saved startup default — never from the session you just left.
 *
 * `session_before_switch` fires while the outgoing session is still bound, so
 * its `ctx.model` is the authoritative source. The module-level variable
 * survives the extension rebind that happens between the two events. Reading
 * `previousSessionFile` is only a fallback: pi does not write a session file
 * until the first assistant message, so a session that only switched models
 * never reaches disk.
 */
let carriedModel: PreviousModel | undefined;

export default function (pi: ExtensionAPI) {
	pi.on("session_before_switch", (event, ctx) => {
		if (event.reason !== "new" || !ctx.model) return;
		carriedModel = { provider: ctx.model.provider, modelId: ctx.model.id };
	});

	pi.on("session_start", async (event: SessionStartEvent, ctx) => {
		// `/resume` restores its own model, and `/fork` / `/clone` copy the model
		// entries from the source session.
		if (event.reason !== "new") return;

		const previous =
			carriedModel ??
			(event.previousSessionFile ? readLastModel(event.previousSessionFile) : undefined);
		carriedModel = undefined;
		if (!previous) return;

		// Nothing to carry over — the new session already resolved to it.
		if (ctx.model?.provider === previous.provider && ctx.model?.id === previous.modelId) return;

		const model = ctx.modelRegistry.find(previous.provider, previous.modelId);
		if (!model) return; // Model no longer exists in the catalog.

		const ok = await pi.setModel(model);
		if (!ok) {
			ctx.ui.notify(`Could not restore model ${previous.provider}/${previous.modelId}: no auth configured`, "error");
		}
	});
}

/** Read the last model recorded in a persisted session JSONL file, if any. */
function readLastModel(sessionFile: string): PreviousModel | undefined {
	let text: string;
	try {
		text = readFileSync(sessionFile, "utf8");
	} catch {
		return undefined;
	}

	let last: PreviousModel | undefined;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.type === "model_change" && entry.provider && entry.modelId) {
			last = { provider: entry.provider, modelId: entry.modelId };
		} else if (
			entry?.type === "message" &&
			entry.message?.role === "assistant" &&
			entry.message.provider &&
			entry.message.model
		) {
			last = { provider: entry.message.provider, modelId: entry.message.model };
		}
	}
	return last;
}
