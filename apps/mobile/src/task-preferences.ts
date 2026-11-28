import type { AgentDTO } from "@ateam/protocol";

export interface TaskPreferences {
	agentId: string | null;
	auto: boolean;
	pickAgent: (id: string) => void;
	setAuto: (on: boolean) => void;
}

/** An empty probe supplies no fallback. Keep the pick so launch can still try it. */
export function taskAgentOnBox(picked: string, installed: readonly string[]) {
	return installed.includes(picked) ? picked : (installed[0] ?? picked);
}

/** Resolve the pick against this box without changing what the phone remembers. */
export function taskAgentOptions(agents: AgentDTO[], preferred: string | null) {
	// The catalog may still be loading, or the box may be asleep until launch.
	const options = agents.length
		? agents
		: [{ id: preferred ?? "claude", label: preferred ?? "Claude Code", available: true }];
	const installed = options.filter((agent) => agent.available).map((agent) => agent.id);
	const id = taskAgentOnBox(preferred ?? options[0].id, installed);
	const current = options.find((agent) => agent.id === id) ?? options[0];
	return { options, current };
}
