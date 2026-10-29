// The Lead chat's renderer↔main contract: one conversation with a coordinator
// agent that drives every task on every engine (see main/lead). Its own surface,
// beside window.ateam (one engine's API) and window.ateamHost (choosing
// engines), because the Lead belongs to the desktop, not to any engine.
// Imports nothing, so both the node and web tsconfigs resolve it.

export const LEAD_CH = {
	/** The conversation so far, plus whether a turn is running. */
	snapshot: "lead:snapshot",
	/** Send the user's message (starts the agent on first use). */
	send: "lead:send",
	/** Interrupt the running turn; the conversation stays. */
	interrupt: "lead:interrupt",
	/** Start a new conversation (the old one is archived, not deleted). */
	reset: "lead:reset",
	/** The user replies to a task's agent from the chat (not through the Lead model). */
	reply: "lead:reply",
	/** The user answers a task's question from the chat; the task is then followed. */
	answer: "lead:answer",
	/** The user answers the Lead's own permission prompt (its agent wants a tool). */
	permission: "lead:permission",
	evtEvent: "evt:lead:event",
} as const;

/** A task named in the chat: enough to label it and open it. */
export interface LeadTaskRef {
	taskId: string;
	name: string;
	agentId: string | null;
}

/** How the user answered the Lead's permission prompt. */
export type LeadPermissionAnswer = "allow" | "always" | "deny";

/** One rendered entry in the chat. A tool entry is updated in place when its result lands. */
export type LeadItem =
	/** The user's words; `to` when they went to a task's agent, not to the Lead. */
	| { kind: "user"; id: string; text: string; at: number; to?: LeadTaskRef }
	/** A followed task's agent finished a turn: its reply, shown to the user only
	 *  (never fed to the Lead's model, so following costs nothing). */
	| { kind: "agent"; id: string; task: LeadTaskRef; text: string; at: number }
	| { kind: "assistant"; id: string; text: string; at: number }
	| {
			kind: "tool";
			id: string;
			/** The tool's short name, without the mcp__ateam_lead__ prefix. */
			name: string;
			input: Record<string, unknown>;
			/** Absent while the call runs. */
			result?: string;
			isError?: boolean;
			at: number;
	  }
	/** The Lead's agent asks before using a tool, as the user's permission
	 *  settings say it must. Nobody watches its terminal, so it is answered here.
	 *  `answer` is absent while it waits, and "cancelled" once the turn stopped
	 *  or the agent went away. */
	| {
			kind: "permission";
			id: string;
			/** What it wants to do, in markdown (the same words as a task's card). */
			text: string;
			/** Claude offers a rule for "Always allow"; kept in the Lead's own settings. */
			canAlways: boolean;
			/** That rule, like "Bash(npm test *)", when there is one. */
			always: string | null;
			answer?: LeadPermissionAnswer | "cancelled";
			at: number;
	  }
	/** Something about the conversation itself: stopped, failed, restarted. */
	| {
			kind: "notice";
			id: string;
			text: string;
			tone: "info" | "error";
			at: number;
			/** The task it is about, when it is about one: the chat offers to open it. */
			task?: LeadTaskRef;
	  };

export interface LeadSnapshot {
	items: LeadItem[];
	/** The assistant text streaming in for the current turn, not yet an item. */
	draft: string;
	/** A turn is running. */
	busy: boolean;
}

/** What main pushes as the conversation moves. `item` adds or replaces by id. */
export type LeadEvent =
	| { type: "item"; item: LeadItem }
	| { type: "draft"; text: string }
	| { type: "busy"; busy: boolean }
	| { type: "reset"; snapshot: LeadSnapshot };

/** window.ateamLead. */
export interface AteamLead {
	snapshot(): Promise<LeadSnapshot>;
	send(text: string): Promise<void>;
	interrupt(): Promise<void>;
	reset(): Promise<void>;
	reply(taskId: string, text: string): Promise<void>;
	answer(input: {
		taskId: string;
		questionId: string;
		answer: string | string[] | null;
	}): Promise<void>;
	permission(id: string, answer: LeadPermissionAnswer): Promise<void>;
	onEvent(cb: (e: LeadEvent) => void): () => void;
}
