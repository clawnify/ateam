// The Lead chat's contract: one conversation with a coordinator agent that
// drives the board (packages/server/src/lead). Two hosts run one:
// - the desktop, in main, over every engine it holds; the renderer reaches it
//   over Electron IPC on these channels (window.ateamLead);
// - a box's engine, over that box alone; it answers LEAD_RPC over the engine's
//   own RPC and pushes LEAD_EVENT. The phone talks to the one on its Lead box,
//   and so does the desktop when its Lead lives on a box (LeadHome).
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
	/** The user answers a task's reply with an emoji: sent to its agent like a
	 *  reply, shown on the reply's card instead of as a message of its own. */
	react: "lead:react",
	/** The user answers a task's question from the chat; the task is then followed. */
	answer: "lead:answer",
	/** The user answers the Lead's own permission prompt (its agent wants a tool). */
	permission: "lead:permission",
	/** Turn Auto mode on or off: Claude's own auto mode, as the ⚡ toggle gives a task. */
	setAuto: "lead:setAuto",
	/** Attach files from this Mac (paths, or null for the picker) to the next message. */
	attach: "lead:attach",
	/** Attach a file that has no path here: a pasted screenshot, an image dragged from a page. */
	attachBytes: "lead:attachBytes",
	/** A small preview of an attached image, as a data: URL (the window's CSP allows no files). */
	thumb: "lead:thumb",
	/** The user created or dismissed a task or loop the Lead proposed. */
	proposal: "lead:proposal",
	/** Items recorded before one the client has: a phone loads a conversation's
	 *  tail first (snapshot's `tail`) and older pages as it scrolls back. */
	older: "lead:older",
	/** Where the desktop's main chat lives: this Mac or a box (LeadHome). */
	home: "lead:home",
	/** Move the desktop's main chat to a box, or with null back to this Mac. */
	setHome: "lead:setHome",
	/** Open a voice call's session with OpenAI (GPT-Live) from this Mac's key:
	 *  the window's WebRTC offer in, the answer out. The key never reaches the window. */
	callStart: "lead:callStart",
	/** Judge what a call heard: was each piece said to the Lead? By this Mac's
	 *  decision model; null when there is none or it didn't answer in time. */
	callJudge: "lead:callJudge",
	/** The user is on a voice call with this chat (true, repeated while it lasts)
	 *  or hung up (false). While a call is on, the Lead's messages and answers to
	 *  tasks wait as permission cards for the user's tap (v32 on a box). */
	callActive: "lead:callActive",
	/** A task's reply as one short line for a call to say, by this Mac's text model. */
	callNudge: "lead:callNudge",
	evtEvent: "evt:lead:event",
	evtHome: "evt:lead:home",
} as const;

/** A line of the chat a voice call's session starts with, so the voice knows
 *  what was said before it (typed or spoken). */
export interface LeadCallTurn {
	role: "user" | "assistant" | "developer";
	text: string;
}

/** What else the gate weighs a call's speech against (callJudge). */
export interface LeadCallJudgeOptions {
	/** What the call just raised, if anything is open. */
	topic?: LeadCallTopic;
	/** The user's words to the Lead just before, in the same utterance, when
	 *  these pieces may carry on from them. */
	continuing?: string;
	/** The voice (which hears the room, not only the words) handed these words
	 *  off as said to it. */
	handedOff?: boolean;
}

/** The most pieces of speech a call judges at once: the call joins its oldest
 *  pieces into one past this, so every word is judged and each verdict is one
 *  piece's (server call-gate.ts). */
export const CALL_MAX_PIECES = 4;

/** Whether a piece of speech a call heard was said to the Lead (callJudge). */
export interface LeadCallVerdict {
	/** The probability it was said to the Lead. */
	p: number;
	send: boolean;
	/** What it most likely was, for the words the user sees when it isn't sent. */
	kind: "lead" | "someone" | "background" | "unclear";
	/** With a topic open (callJudge's `topic`): whether it is about that topic. */
	onTopic?: boolean;
	/** With a confirmation open: the user's yes or no to it, when it is one. */
	answer?: "approve" | "refuse" | null;
	/** With a decision's options open: the one the user clearly chose, by index. */
	choice?: number | null;
}

/** What a call just raised, for judging what comes next against it: a
 *  confirmation (a card) may be answered by voice; a decision (a task's
 *  question with options) is talked about, or one of its buttons clearly
 *  picked; a task's reply, said in one line, is only talked about. */
export interface LeadCallTopic {
	kind: "confirm" | "decision" | "reply";
	text: string;
	/** A decision's buttons, in order; the user's words may pick one. */
	options?: { label: string; recommended?: boolean; description?: string }[];
}

/** The channels a box's engine answers for its own Lead (v24; `react` since
 *  v28). Attaching by path and previews are the client's: it has no paths on
 *  the box and keeps its own previews. `attachBytes` takes the file as base64
 *  there, since RPC frames are JSON. */
export const LEAD_RPC = [
	LEAD_CH.snapshot,
	LEAD_CH.send,
	LEAD_CH.interrupt,
	LEAD_CH.reset,
	LEAD_CH.reply,
	LEAD_CH.answer,
	LEAD_CH.permission,
	LEAD_CH.setAuto,
	LEAD_CH.attachBytes,
	LEAD_CH.proposal,
	LEAD_CH.older,
	LEAD_CH.react,
	LEAD_CH.callActive,
	LEAD_CH.callStart,
	LEAD_CH.callJudge,
	LEAD_CH.callNudge,
] as const;

/** The engine's push event for its Lead, with a LeadEvent payload. Sent only
 *  to a connection that has called one of LEAD_RPC. */
export const LEAD_EVENT = "leadEvent";

/** How the Lead links a task in its replies, `[fix login](task:<id>)` (its
 *  prompt says so): the chat draws the link as a chip that opens the task. */
export const TASK_LINK_SCHEME = "task:";

/** A task named in the chat: enough to label it and open it. */
export interface LeadTaskRef {
	taskId: string;
	name: string;
	agentId: string | null;
}

/** A file the user attached in the chat: a copy in the Lead's folder on this Mac. */
export interface LeadFile {
	path: string;
	name: string;
	size: number;
	/** Shown as a thumbnail rather than a chip. */
	image: boolean;
}

/** What attaching gave: the files kept, and why any others were not. */
export interface LeadAttachResult {
	files: LeadFile[];
	failed: string[];
}

/** How the user answered the Lead's permission prompt. */
export type LeadPermissionAnswer = "allow" | "always" | "deny";

/** A task or loop the Lead proposes (propose_task, propose_loop): the fields
 *  of an agent's proposal (TaskProposalDTO), checked by the same rules. */
export interface LeadProposal {
	kind: "task" | "loop";
	name: string;
	prompt: string;
	reason?: string;
	agentId?: string;
	/** Only a suggestion: the dialog shows it and leaves Auto mode off. */
	yolo?: boolean;
	everyMinutes?: number;
	dailyAt?: string;
	followUp?: string;
}

/** What became of a proposal: created from its dialog, dismissed, or
 *  replaced by a later proposal of the same name. */
export type LeadProposalOutcome = "created" | "dismissed" | "replaced";

/** One rendered entry in the chat. A tool entry is updated in place when its result lands. */
export type LeadItem =
	/** The user's words; `to` when they went to a task's agent, not to the Lead.
	 *  `question` is the text of the task's question they answer (ask_user),
	 *  kept here because the task's own copy is cleared once answered. */
	| {
			kind: "user";
			id: string;
			text: string;
			at: number;
			to?: LeadTaskRef;
			question?: string;
			files?: LeadFile[];
	  }
	/** A followed task's agent finished a turn: its reply, shown to the user only
	 *  (never fed to the Lead's model, so following costs nothing). */
	| {
			kind: "agent";
			id: string;
			task: LeadTaskRef;
			text: string;
			at: number;
			/** The emoji the user answered it with (react), drawn on its card. */
			reaction?: string;
	  }
	/** A followed task's agent showed the user a page (show_page): drawn in the
	 *  thread from the task, so a page replaced since says so. */
	| { kind: "page"; id: string; task: LeadTaskRef; pageId: string; title: string; at: number }
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
	/** A task or loop the Lead proposes. Nothing exists until the user creates
	 *  it from the New task or New loop dialog, filled in from this. The chat
	 *  shows the outcome, and the Lead's agent hears it with the user's next
	 *  message (LeadSession.note). */
	| {
			kind: "proposal";
			id: string;
			/** The project it is for, and its name when proposed. */
			projectId: string;
			projectName: string;
			proposal: LeadProposal;
			/** Files attached in this chat, to start the task with. */
			files?: string[];
			/** Absent while it waits on the user. */
			outcome?: LeadProposalOutcome;
			/** The task created from it, when it was a task. */
			task?: LeadTaskRef;
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
	/** Auto mode is on: Claude's auto mode, where a classifier approves what is
	 *  safe, in place of the user's own default mode. Kept across conversations. */
	auto: boolean;
	/** Older items exist than `items` holds (a snapshot asked with a tail);
	 *  `lead:older` pages them in. Absent: `items` is the whole conversation. */
	more?: boolean;
}

/** What main pushes as the conversation moves. `item` adds or replaces by id. */
export type LeadEvent =
	| { type: "item"; item: LeadItem }
	| { type: "draft"; text: string }
	| { type: "busy"; busy: boolean }
	| { type: "auto"; auto: boolean }
	| { type: "reset"; snapshot: LeadSnapshot };

/** A box's own Lead, as a remote client (the phone, or the desktop when its
 *  Lead lives on a box) reaches it over the engine's RPC (leadClient in
 *  client-api.ts). window.ateamLead minus what needs a path on the Lead's
 *  machine: files arrive as bytes. */
export interface LeadClient {
	/** `tail`: only the last that many items (`more` says older ones exist). A
	 *  box before this answers the whole conversation, which reads the same. */
	snapshot(opts?: { tail?: number }): Promise<LeadSnapshot>;
	/** Up to `limit` items before `beforeId`, oldest first. A box before this
	 *  rejects it, but it only ever sends whole conversations, so it isn't asked. */
	older(beforeId: string, limit: number): Promise<{ items: LeadItem[]; more: boolean }>;
	/** `files`: paths `attachBytes` returned. */
	send(text: string, files?: string[]): Promise<void>;
	/** A file from this device, base64, at most 10 MB decoded. */
	attachBytes(name: string, base64: string): Promise<LeadFile>;
	interrupt(): Promise<void>;
	reset(): Promise<void>;
	reply(taskId: string, text: string): Promise<void>;
	/** An emoji answer to an agent's reply (`id`, a `kind: "agent"` item). A box
	 *  before v28 rejects it: gate on boxSupports("leadReact"). */
	react(id: string, emoji: string): Promise<void>;
	answer(input: {
		taskId: string;
		questionId: string;
		answer: string | string[] | null;
	}): Promise<void>;
	permission(id: string, answer: LeadPermissionAnswer): Promise<void>;
	/** Auto mode on or off for the box's Lead (Claude's own auto mode). */
	setAuto(on: boolean): Promise<void>;
	/** On a voice call with the box's Lead (true, repeated while it lasts) or
	 *  not. A box before v32 rejects it: gate on boxSupports("leadCall"). */
	callActive(on: boolean): Promise<void>;
	/** The box opens a call's voice session with OpenAI from its own key, the
	 *  box judges what the call heard, and words a task's reply in one line.
	 *  A box before v33 rejects them: gate on boxSupports("leadCallSession"). */
	callStart(sdp: string, input: LeadCallTurn[]): Promise<{ sdp: string; sessionId: string }>;
	callJudge(
		pieces: string[],
		context: string,
		opts?: LeadCallJudgeOptions,
	): Promise<LeadCallVerdict[] | null>;
	callNudge(task: string, reply: string): Promise<string>;
	dismissProposal(id: string): Promise<void>;
	/** A proposal was created from its sheet or form on this device: the card
	 *  says so, and a task (`taskId`) is followed for its replies. */
	proposalCreated(id: string, taskId?: string): Promise<void>;
	/** Events start once any call above has been made on this connection. */
	onEvent(cb: (e: LeadEvent) => void): () => void;
}

/** Where the desktop's main Lead chat lives (`client.leadBox`). A project
 *  window's chat is always this Mac's. */
export interface LeadHome {
	/** The box whose own Lead is the main chat, or null for this Mac. */
	box: string | null;
	/** That box is held right now (always true for this Mac). */
	connected: boolean;
	/** Emoji answers work there (this Mac, or a box on v28 or later). */
	canReact: boolean;
	/** Voice calls work there (this Mac, or a box on v32 or later, whose Lead
	 *  holds its messages to tasks for a tap during a call). */
	canCall: boolean;
}

/** window.ateamLead. */
export interface AteamLead {
	/** `tail`: only the last that many items (`more` says older ones exist). */
	snapshot(opts?: { tail?: number }): Promise<LeadSnapshot>;
	/** Up to `limit` items before `beforeId`, oldest first. */
	older(beforeId: string, limit: number): Promise<{ items: LeadItem[]; more: boolean }>;
	/** `files`: paths of files attached in this chat (from attach or attachBytes). */
	send(text: string, files?: string[]): Promise<void>;
	attach(paths: string[] | null): Promise<LeadAttachResult>;
	attachBytes(name: string, data: Uint8Array): Promise<LeadFile>;
	thumb(path: string): Promise<string | null>;
	interrupt(): Promise<void>;
	reset(): Promise<void>;
	reply(taskId: string, text: string): Promise<void>;
	/** `id`: the agent reply (a `kind: "agent"` item) the emoji answers. */
	react(id: string, emoji: string): Promise<void>;
	answer(input: {
		taskId: string;
		questionId: string;
		answer: string | string[] | null;
	}): Promise<void>;
	permission(id: string, answer: LeadPermissionAnswer): Promise<void>;
	setAuto(on: boolean): Promise<void>;
	/** The user created (`taskId` when it was a task) or dismissed a proposal. */
	proposal(id: string, outcome: "created" | "dismissed", taskId?: string): Promise<void>;
	onEvent(cb: (e: LeadEvent) => void): () => void;
	/** Where the calling window's chat lives. */
	home(): Promise<LeadHome>;
	/** Move the main chat to a box (its own Lead, a separate conversation), or
	 *  with null back to this Mac's. Nothing is copied between them. */
	setHome(box: string | null): Promise<LeadHome>;
	onHome(cb: (home: LeadHome) => void): () => void;
	/** Start a voice call's session: `sdp` is the window's WebRTC offer, `input`
	 *  the chat so far. Answers OpenAI's SDP answer. Throws with words for the
	 *  user (no OpenAI key, OpenAI refused). */
	callStart(sdp: string, input: LeadCallTurn[]): Promise<{ sdp: string; sessionId: string }>;
	/** `pieces`: what the call heard, split at pauses; `context`: the last turns. */
	callJudge(
		pieces: string[],
		context: string,
		opts?: LeadCallJudgeOptions,
	): Promise<LeadCallVerdict[] | null>;
	/** The user is on a call with the calling window's chat (true, repeated
	 *  while it lasts) or hung up (false). Throws when that chat lives on a box
	 *  too old to hold its Lead's messages for a tap. */
	callActive(on: boolean): Promise<void>;
	/** One short spoken line for a task's reply (`task` its name): what it did or
	 *  found, and "It needs you." only when it asks the user something. */
	callNudge(task: string, reply: string): Promise<string>;
}
