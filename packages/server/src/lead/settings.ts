import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAgentAvailable } from "@ateam/agents";
import type { ChatAgent, ChatSettings, ChatSettingsResult } from "@ateam/protocol";
import { readSettings, settingsPath, updateSettings } from "../settings-file";

const AGENTS: ChatAgent[] = ["claude", "codex", "opencode"];
export interface ChatPreferences {
	get(): ChatSettings;
	update(patch: Partial<ChatSettings>): Promise<ChatSettingsResult>;
	snapshot(): Promise<ChatSettingsResult>;
	subscribe(cb: (settings: ChatSettings) => void): () => void;
}

/** One owner per machine, shared by its main and project Chat sessions. */
export function chatPreferences(
	legacyDir: string,
	path = settingsPath(),
	available = isAgentAvailable,
): ChatPreferences {
	const listeners = new Set<(settings: ChatSettings) => void>();
	let legacyAuto = false;
	try {
		legacyAuto = JSON.parse(readFileSync(join(legacyDir, "state.json"), "utf8")).auto === true;
	} catch {
		/* first use */
	}
	const get = (): ChatSettings => {
		const saved = readSettings(path).settings.chat;
		return {
			agent: saved && AGENTS.includes(saved.agent) ? saved.agent : "claude",
			auto: saved ? saved.auto === true : legacyAuto,
		};
	};
	const snapshot = async (): Promise<ChatSettingsResult> => ({
		settings: get(),
		agents: await Promise.all(AGENTS.map(async (id) => ({ id, available: await available(id) }))),
	});
	return {
		get,
		snapshot,
		async update(patch) {
			if (
				!patch ||
				typeof patch !== "object" ||
				Array.isArray(patch) ||
				Object.keys(patch).some((k) => k !== "agent" && k !== "auto")
			)
				throw new Error("Invalid Chat settings.");
			if (patch.agent !== undefined && !AGENTS.includes(patch.agent))
				throw new Error("Unknown Chat agent.");
			if (patch.auto !== undefined && typeof patch.auto !== "boolean")
				throw new Error("Auto must be on or off.");
			if (patch.agent && !(await available(patch.agent)))
				throw new Error(`Install ${patch.agent} on this machine first, then sign in with its CLI.`);
			const next = { ...get(), ...patch };
			updateSettings({ chat: next }, path);
			for (const cb of listeners) cb(next);
			return snapshot();
		},
		subscribe(cb) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
	};
}
