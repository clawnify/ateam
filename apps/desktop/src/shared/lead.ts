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
	evtEvent: "evt:lead:event",
} as const;

/** One rendered entry in the chat. A tool entry is updated in place when its result lands. */
export type LeadItem =
	| { kind: "user"; id: string; text: string; at: number }
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
	/** Something about the conversation itself: stopped, failed, restarted. */
	| { kind: "notice"; id: string; text: string; tone: "info" | "error"; at: number };

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
	onEvent(cb: (e: LeadEvent) => void): () => void;
}
