import { expect, jest, test } from "bun:test";
import type { AteamLead, LeadCallVerdict, LeadItem } from "./lead";
import {
	activeTopic,
	announcement,
	type CallMedia,
	contextFrom,
	decisionLine,
	gist,
	heldReason,
	IN_PROGRESS,
	LeadCall,
	optionsOf,
	piecesOf,
	QUIET_JUDGE_MS,
	rideAlong,
	shouldHold,
	speakable,
	turnsFrom,
	UNDO_MS,
	UTTERANCE_GAP_MS,
	waitingOnUser,
	withCarry,
} from "./lead-call";

const task = { taskId: "t1", name: "Disk usage on the box page", agentId: "claude" };

test("speakable keeps the words of links, drops markdown and code", () => {
	expect(speakable("See [the disk task](task:abc123) and **PR 512**.")).toBe(
		"See the disk task and PR 512.",
	);
	expect(speakable("Run:\n```sh\nbun test\n```\nthen `merge`.")).toBe(
		"Run: (code in the chat) then merge.",
	);
	expect(speakable("## Plan\n- one\n- two\n> quoted")).toBe("Plan one two quoted");
});

test("speakable cuts a long reply at a sentence and says where the rest is", () => {
	const long = `${"This sentence is about the board. ".repeat(100)}`;
	const s = speakable(long, 200);
	expect(s.length).toBeLessThan(260);
	expect(s.endsWith("board. The rest is in the chat.")).toBe(true);
});

test("turnsFrom gives the voice the chat: the user's words, the Lead's, task replies", () => {
	const items: LeadItem[] = [
		{ kind: "user", id: "1", text: "What's in flight?", at: 1 },
		{ kind: "tool", id: "2", name: "get_board", input: {}, at: 2 },
		{ kind: "assistant", id: "3", text: "Three tasks: [disk](task:t1) is running.", at: 3 },
		{ kind: "user", id: "4", text: "use the short tone", at: 4, to: task },
		{ kind: "agent", id: "5", task, text: "Done, PR 512 is up.", at: 5 },
	];
	expect(turnsFrom(items)).toEqual([
		{ role: "user", text: "What's in flight?" },
		{ role: "assistant", text: "Three tasks: disk is running." },
		{ role: "user", text: '(to the task "Disk usage on the box page") use the short tone' },
		{
			role: "developer",
			text: 'The task "Disk usage on the box page" replied: Done, PR 512 is up.',
		},
	]);
});

test("announcement speaks up for task news and waiting approvals, not for settled ones", () => {
	expect(announcement({ kind: "agent", id: "a", task, text: "Done.", at: 1 })).toBe(
		'The task "Disk usage on the box page" replied. It\'s in the chat.',
	);
	const perm: LeadItem = {
		kind: "permission",
		id: "p",
		text: "Run `rm -rf build`",
		canAlways: false,
		always: null,
		at: 1,
	};
	expect(announcement(perm)).toBe("I need your OK in the chat for this: Run rm -rf build");
	expect(announcement({ ...perm, answer: "allow" })).toBeNull();
	expect(announcement({ kind: "assistant", id: "x", text: "hi", at: 1 })).toBeNull();
	expect(
		announcement({ kind: "notice", id: "n", text: "Restarted.", tone: "info", at: 1 }),
	).toBeNull();
});

test("piecesOf splits at a pause where a sentence ended, so side talk isn't glued to a request", () => {
	const frags = [
		{ text: " Do you want", start: 0, end: 200 },
		{ text: " pizza tonight?", start: 200, end: 600 },
		{ text: " Okay, start a task", start: 2000, end: 2400 },
		{ text: " for disk usage.", start: 2500, end: 2900 },
	];
	expect(piecesOf(frags)).toEqual([
		"Do you want pizza tonight?",
		"Okay, start a task for disk usage.",
	]);
	// A "?" that arrives late, timed with the next words, stays with its question.
	expect(
		piecesOf([
			{ text: " pizza tonight", start: 0, end: 600 },
			{ text: "?", start: 1900, end: 2000 },
			{ text: " Okay, start a task", start: 2000, end: 2400 },
		]),
	).toEqual(["pizza tonight?", "Okay, start a task"]);
	// The end mark at the start of the next fragment, as the transcript puts it (live).
	expect(
		piecesOf([
			{ text: "Mom, hold on a second", start: 0, end: 1400 },
			{ text: ". Delete the old test box", start: 2500, end: 3700 },
		]),
	).toEqual(["Mom, hold on a second.", "Delete the old test box"]);
	expect(piecesOf([])).toEqual([]);
	expect(piecesOf([{ text: "   ", start: 0, end: 10 }])).toEqual([]);
});

test("piecesOf keeps a sentence said slowly whole: its pauses are not its ends", () => {
	// Live, 2026-11-05: 2.3 s pauses inside one sentence.
	const slow = [
		{ text: "In the web project", start: 6200, end: 7200 },
		{ text: ", send a task", start: 9800, end: 10400 },
		{ text: " to check whether the agents read their instructions", start: 12800, end: 15300 },
	];
	expect(piecesOf(slow)).toEqual([
		"In the web project, send a task to check whether the agents read their instructions",
	]);
	// Trailing off ("...") is a pause in a thought, not its end.
	expect(
		piecesOf([
			{ text: "In the web project...", start: 0, end: 900 },
			{ text: " send a task", start: 3000, end: 3600 },
		]),
	).toEqual(["In the web project... send a task"]);
	// Past the cap, the oldest sentences join: no word is dropped.
	const five = ["One.", "Two.", "Three.", "Four.", "Five."].map((text, i) => ({
		text: ` ${text}`,
		start: i * 2000,
		end: i * 2000 + 500,
	}));
	expect(piecesOf(five, 800, 4)).toEqual(["One. Two.", "Three.", "Four.", "Five."]);
});

test("rideAlong: once an utterance is for the Lead, its fragments go too; side talk stays back", () => {
	const p = (text: string, lead: boolean, kind: "lead" | "someone" | "background" | "unclear") => ({
		text,
		lead,
		kind,
	});
	// "instructions" alone reads as nobody's; next to a request it is part of it.
	expect(
		rideAlong([p("send a task to check", true, "lead"), p("instructions", false, "unclear")]),
	).toEqual({ lead: ["send a task to check", "instructions"], held: [] });
	// Said to someone else in the same breath: still held.
	expect(
		rideAlong([
			p("Mum, hold on a second.", false, "someone"),
			p("Delete the old box.", true, "lead"),
		]),
	).toEqual({
		lead: ["Delete the old box."],
		held: [p("Mum, hold on a second.", false, "someone")],
	});
	// Nothing for the Lead: all of it held, fragments too.
	expect(rideAlong([p("instructions", false, "unclear")]).lead).toEqual([]);
});

test("withCarry judges a held start of an utterance again with what came next", () => {
	// Held as nobody's: judged again, as one sentence.
	expect(
		withCarry(["send a task", "to check"], { sent: false, held: ["In the web project"] }),
	).toEqual({
		pieces: ["In the web project send a task", "to check"],
		carried: ["In the web project"],
	});
	// Already sent, or nothing held, or a new utterance: as heard.
	expect(withCarry(["more"], { sent: true, held: [] }).carried).toEqual([]);
	expect(withCarry(["more"], { sent: false, held: [] }).pieces).toEqual(["more"]);
	expect(withCarry(["more"], null).pieces).toEqual(["more"]);
	// A long held stretch keeps its newest words.
	const long = withCarry(["end"], { sent: false, held: ["x".repeat(800)] }).pieces[0] ?? "";
	expect(long.length).toBe(600);
	expect(long.endsWith(" end")).toBe(true);
});

test("shouldHold: quiet holds at 30 s, a false wake at 10 s, endless side talk at 90 s", () => {
	const at = (s: number) => s * 1000;
	const base = { engagedAt: 0, falseWake: false };
	// Quiet room, nothing for the Lead for 31 s.
	expect(shouldHold({ ...base, now: at(31), heardAt: at(20) })).toBe(true);
	expect(shouldHold({ ...base, now: at(29), heardAt: at(20) })).toBe(false);
	// Someone is still talking at 31 s: not yet (it may be a long thought for the Lead).
	expect(shouldHold({ ...base, now: at(31), heardAt: at(30) })).toBe(false);
	// A TV that never stops: on hold 90 s after the last thing for the Lead.
	expect(shouldHold({ ...base, now: at(91), heardAt: at(91) })).toBe(true);
	// Woken by a sound, nothing for the Lead, 1.5 s quiet: back after 10 s.
	expect(shouldHold({ engagedAt: 0, falseWake: true, now: at(11), heardAt: at(9) })).toBe(true);
	expect(shouldHold({ engagedAt: 0, falseWake: true, now: at(11), heardAt: at(10.5) })).toBe(false);
});

test("contextFrom gives the gate the chat and what was held back, in time order, with ages", () => {
	const now = 100_000;
	const items: LeadItem[] = [
		{ kind: "user", id: "1", text: "Tell the checklist one to be friendly.", at: 66_000 },
		{ kind: "assistant", id: "2", text: "Should I message [it](task:t1)?", at: 75_000 },
		{ kind: "user", id: "3", text: "use the short tone", at: 80_000, to: task },
		{ kind: "agent", id: "4", task, text: "Done.", at: 81_000 },
	];
	const asides = [
		{ text: "Did you give food to the cat?", kind: "someone" as const, at: 96_000 },
		// Too old to say anything about what comes next.
		{ text: "Old news on TV.", kind: "background" as const, at: now - 150_000 },
	];
	const said = [{ text: "The disk task says it is done.", at: 90_000 }];
	expect(contextFrom(items, { asides, said }, now)).toBe(
		[
			"user (34 s ago): Tell the checklist one to be friendly.",
			"lead (25 s ago): Should I message it?",
			'the task "Disk usage on the box page" replied (19 s ago): Done.',
			"lead, said on the call (10 s ago): The disk task says it is done.",
			'heard, not sent to the Lead (4 s ago), said to someone else in the room: "Did you give food to the cat?"',
		].join("\n"),
	);
	// A long message keeps its end, where its question is.
	const long = `Thanks, it went through. ${"It started the task with your question. ".repeat(20)}Can it stop the simulator?`;
	const g = gist(long, 300);
	expect(g.startsWith("Thanks, it went through.")).toBe(true);
	expect(g.endsWith("Can it stop the simulator?")).toBe(true);
	expect(g.length).toBeLessThanOrEqual(303);
	expect(gist("Short.", 300)).toBe("Short.");
	expect(heldReason("someone")).toBe("sounded like you were talking to someone else");
});

test("shouldHold while the Lead works: after 15 s when it waits on a tap, else after 60 s", () => {
	const at = (s: number) => s * 1000;
	const base = { engagedAt: 0, falseWake: false, pending: true };
	// The Lead waits on the user's tap (announced): no reason to bill the silence.
	expect(shouldHold({ ...base, waitingOnUser: true, now: at(16), heardAt: at(5) })).toBe(true);
	expect(shouldHold({ ...base, waitingOnUser: true, now: at(14), heardAt: at(5) })).toBe(false);
	// A long turn: hold after a minute; its reply reopens the call.
	expect(shouldHold({ ...base, waitingOnUser: false, now: at(59), heardAt: at(5) })).toBe(false);
	expect(shouldHold({ ...base, waitingOnUser: false, now: at(61), heardAt: at(5) })).toBe(true);
	// Never while someone is talking.
	expect(shouldHold({ ...base, waitingOnUser: true, now: at(61), heardAt: at(60) })).toBe(false);
});

test("waitingOnUser: a permission card nobody answered", () => {
	const card = {
		kind: "permission" as const,
		id: "c",
		text: "Send?",
		canAlways: false,
		always: null,
		at: 1,
	};
	expect(waitingOnUser([card])).toBe(true);
	expect(waitingOnUser([{ ...card, answer: "allow" as const }])).toBe(false);
	expect(waitingOnUser([{ kind: "user", id: "u", text: "hi", at: 1 }])).toBe(false);
});

test("activeTopic: a countdown first, then a card for 30 s, then a decision for 2 min", () => {
	const card = { kind: "confirm" as const, id: "c", text: "Send this?", at: 0 };
	const decision = {
		kind: "decision" as const,
		taskId: "t",
		questionId: "q",
		name: "Email",
		text: "Switch?",
		options: [{ label: "Switch", recommended: true }, { label: "Keep" }],
		at: 0,
	};
	expect(activeTopic(1_000, card, { text: "Send this?" })).toEqual({
		kind: "confirm",
		text: "about to go ahead: Send this?",
		open: null,
	});
	expect(activeTopic(29_000, card, null)?.open).toBe(card);
	expect(activeTopic(31_000, card, null)).toBeNull();
	expect(activeTopic(119_000, decision, null)?.kind).toBe("decision");
	// A decision's buttons go to the gate, so "go ahead" can pick one.
	expect(activeTopic(1_000, decision, null)?.options?.map((o) => o.label)).toEqual([
		"Switch",
		"Keep",
	]);
	expect(activeTopic(121_000, decision, null)).toBeNull();
	expect(activeTopic(0, null, null)).toBeNull();
	// A task's reply the voice summed up: talked about for 2 min, no buttons.
	const reply = {
		kind: "reply" as const,
		taskId: "t",
		name: "Errors",
		text: "It found network issues.",
		at: 0,
	};
	expect(activeTopic(119_000, reply, null)).toEqual({
		kind: "reply",
		text: "It found network issues.",
		open: reply,
	});
	expect(activeTopic(121_000, reply, null)).toBeNull();
});

test("decisionLine tells a decision once, unhurried, by its first line", () => {
	expect(
		decisionLine("Email sending", "**Switch to managed sending?**\n\nIn July we said..."),
	).toBe(
		'The task "Email sending" needs a decision from you: Switch to managed sending?. It\'s waiting in the chat, so take your time. Want me to walk you through it?',
	);
});

test("optionsOf: a question's buttons with the agent's pick, none for a checklist", () => {
	const q = {
		id: "q",
		text: "Switch?",
		options: ["Switch", "Keep"],
		choices: [{ label: "Switch", recommended: true, description: "We send" }, { label: "Keep" }],
	};
	expect(optionsOf(q)).toEqual([
		{ label: "Switch", recommended: true, description: "We send" },
		{ label: "Keep" },
	]);
	expect(optionsOf({ ...q, choices: undefined })).toEqual([{ label: "Switch" }, { label: "Keep" }]);
	expect(optionsOf({ ...q, select: "many" })).toEqual([]);
});

test("shouldHold waits for words not judged yet, except past the chatter cap", () => {
	const at = (s: number) => s * 1000;
	const base = { engagedAt: 0, falseWake: false };
	// Quiet for 4 s after 31 s idle: holds, unless the last words wait on the gate.
	expect(shouldHold({ ...base, now: at(31), heardAt: at(27) })).toBe(true);
	expect(shouldHold({ ...base, now: at(31), heardAt: at(27), unjudged: true })).toBe(false);
	expect(
		shouldHold({ engagedAt: 0, falseWake: true, now: at(11), heardAt: at(9), unjudged: true }),
	).toBe(false);
	// A TV that never stops: on hold at the cap all the same.
	expect(shouldHold({ ...base, now: at(91), heardAt: at(91), unjudged: true })).toBe(true);
	// A pause the quiet timer judged at is still inside one utterance.
	expect(UTTERANCE_GAP_MS).toBeGreaterThan(QUIET_JUDGE_MS);
});

// The call itself, driven through a fake Lead: what it asks the gate, what it sends.
const lead = (p = 0.9): LeadCallVerdict => ({ p, send: true, kind: "lead" });
const nobodys: LeadCallVerdict = { p: 0.3, send: false, kind: "unclear" };
function fakeCall(
	gate: (pieces: string[], opts?: { continuing?: string }) => LeadCallVerdict[] | null,
	level = () => 0,
) {
	// The app's media: what the call asked of it, in order. No network here,
	// so a session never opens.
	const did: string[] = [];
	const media: CallMedia = {
		openMic: async () => ({ getAudioTracks: () => [], getTracks: () => [] }),
		newPeer: () => {
			did.push("peer");
			throw new Error("no network in tests");
		},
		meter: () => {
			did.push("meter");
			return { level, stop: () => did.push("meter stopped") };
		},
		chime: () => did.push("chime"),
		close: () => did.push("closed"),
	};
	const judged: { pieces: string[]; opts: Parameters<AteamLead["callJudge"]>[2] }[] = [];
	const sent: string[] = [];
	const leadAnswered: unknown[] = [];
	const fake = {
		callJudge: async (pieces: string[], _context: string, opts?: { continuing?: string }) => {
			judged.push({ pieces, opts });
			return gate(pieces, opts);
		},
		send: async (text: string) => {
			sent.push(text);
		},
		callNudge: async () => "The disk task says it is done.",
		answer: async (input: unknown) => {
			leadAnswered.push(input);
		},
		callActive: async () => {},
	} as unknown as AteamLead;
	const call = new LeadCall(() => fake, media);
	// biome-ignore lint/suspicious/noExplicitAny: these tests drive the call's private state.
	const c = call as any;
	const hear = (text: string, start: number) =>
		c.onVoice({
			type: "session.input_transcript.delta",
			delta: text,
			start_ms: start,
			end_ms: start + 400,
		});
	const stop = () => {
		for (const t of [c.judgeTimer, c.heldTimer, c.approval?.timer]) if (t) clearTimeout(t);
	};
	return { call, c, judged, sent, leadAnswered, hear, stop, did };
}

test("on hold the meter has the mic, from when the session closed until the next one opens", async () => {
	let loud = 0;
	const { call, c, did } = fakeCall(
		() => null,
		() => loud,
	);
	c.mic = { getAudioTracks: () => [], getTracks: () => [] };
	c.view.state = "live";
	c.listen();
	await c.toHold();
	expect(did).toEqual(["meter"]);
	// Someone starts talking: the chime, and the meter lets go before the
	// session takes the mic (on a phone, two can't hold it).
	loud = 0.2;
	await new Promise((r) => setTimeout(r, 450));
	loud = 0;
	expect(did.slice(0, 4)).toEqual(["meter", "chime", "meter stopped", "peer"]);
	// It didn't connect: on hold again, listening, and it says why.
	await new Promise((r) => setTimeout(r, 20));
	expect(call.view).toMatchObject({ state: "hold", error: "no network in tests" });
	expect(did.at(-1)).toBe("meter");
	call.hangUp();
	expect(did.slice(-2)).toEqual(["meter stopped", "closed"]);
});

test("a phone call holds the call: no session, no listening, and its news waits", async () => {
	const { call, c, did } = fakeCall(() => null);
	c.mic = { getAudioTracks: () => [], getTracks: () => [] };
	c.view.state = "hold";
	c.hearOnHold();
	call.setPaused(true);
	expect(call.view.paused).toBe(true);
	expect(did).toEqual(["meter", "meter stopped"]);
	// A task's news and the Talk button while the other call is on: nothing opens.
	c.say("The disk task says it is done.");
	call.talk();
	expect(did).toEqual(["meter", "meter stopped"]);
	// The phone call is over: the news that waited opens a session (none here:
	// back on hold, listening).
	call.setPaused(false);
	expect(did.slice(2)).toEqual(["chime", "peer"]);
	await new Promise((r) => setTimeout(r, 0));
	expect(did.at(-1)).toBe("meter");
	call.hangUp();
	expect(call.view.paused).toBe(false);
});

test("relink listens on the new connection and tells what came meanwhile", async () => {
	const { call, c } = fakeCall(() => null);
	const subs: string[] = [];
	const conn = (name: string, items: LeadItem[]) => ({
		onEvent: () => {
			subs.push(`on ${name}`);
			return () => subs.push(`off ${name}`);
		},
		snapshot: async () => ({ items, draft: "", busy: false, auto: false }),
		callActive: async () => {},
		callNudge: async () => "The disk task says it is done.",
	});
	const reply: LeadItem = {
		kind: "agent",
		id: "a9",
		task: { taskId: "t2", name: "Disk usage", agentId: null },
		text: "Done.",
		at: 1,
	};
	c.lead = () => conn("old", []);
	c.view.state = "hold";
	c.unsub = c.lead().onEvent();
	// The box reconnected; a task replied in between.
	c.lead = () => conn("new", [reply]);
	call.relink();
	await new Promise((r) => setTimeout(r, 0));
	expect(subs).toEqual(["on old", "off old", "on new"]);
	expect(c.said.at(-1)?.text).toBe("The disk task says it is done.");
	call.hangUp();
});

test("hanging up while the call starts stops it there, with no error", async () => {
	const { call, did } = fakeCall(() => null);
	let micAsked: () => void = () => {};
	const stopped: string[] = [];
	// The phone's start: the system call, then the mic, which takes a while.
	(call as unknown as { media: CallMedia }).media.openMic = () =>
		new Promise((resolve) => {
			micAsked = () =>
				resolve({
					getAudioTracks: () => [],
					getTracks: () => [{ enabled: true, stop: () => stopped.push("mic") }],
				});
		});
	const lead = (call as unknown as { lead: () => Record<string, unknown> }).lead();
	lead.snapshot = async () => ({ items: [], draft: "", busy: false, auto: false });
	lead.onEvent = () => () => {};
	const starting = call.start();
	await new Promise((r) => setTimeout(r, 0));
	call.hangUp();
	micAsked();
	await starting;
	expect(call.view).toMatchObject({ state: "off", error: "" });
	// The mic it got after all is let go, and no session was asked for.
	expect(stopped).toEqual(["mic"]);
	expect(did).not.toContain("peer");
});

test("a session OpenAI ended goes on hold and listens at once, asking it nothing", async () => {
	const { call, c, did } = fakeCall(() => null);
	const asked: string[] = [];
	c.mic = { getAudioTracks: () => [], getTracks: () => [] };
	c.pc = { close: () => did.push("session closed") };
	c.dc = { readyState: "open", send: (d: string) => asked.push(d) };
	c.view.state = "live";
	c.onVoice({ type: "session.closed" });
	await new Promise((r) => setTimeout(r, 0));
	expect(call.view.state).toBe("hold");
	expect(asked).toEqual([]);
	expect(did).toEqual(["session closed", "meter"]);
	call.hangUp();
});

test("a hold judges what was heard before closing the session, never drops it", async () => {
	const { c, judged, sent, hear, stop } = fakeCall((p) => p.map(() => lead()));
	c.view.state = "live";
	hear("Start a task for disk usage", 0);
	await c.toHold();
	await c.judging;
	expect(judged.map((j) => j.pieces)).toEqual([["Start a task for disk usage"]]);
	expect(sent).toEqual(["Start a task for disk usage"]);
	stop();
});

test("after a pause, the gate's answer on carrying on decides; without one, the hand-off does", async () => {
	// The gate answered: it doesn't carry on. Held, though it reads as nobody's.
	const a = fakeCall((p, o) => p.map(() => (o?.continuing ? nobodys : lead())));
	a.hear("Delete the old test box.", 0);
	await a.c.judge(null);
	a.hear("um where is it", 5000);
	// The quiet timer judged in between: a pause just past it.
	a.c.batchFrom = a.c.utter.until + QUIET_JUDGE_MS + 100;
	await a.c.judge(null);
	expect(a.judged[1]?.opts?.continuing).toBe("Delete the old test box.");
	expect(a.sent).toEqual(["Delete the old test box."]);
	expect(a.call.view.held?.text).toBe("um where is it");
	a.stop();
	// No answer (no model, a timeout, a refusal): held, unless the voice handed
	// the words off. A TV line after a request must not ride along on silence.
	const b = fakeCall((p, o) => (o?.continuing ? null : p.map(() => lead())));
	b.hear("Delete the old test box", 0);
	await b.c.judge(null);
	b.hear("Officials say the storm will reach the coast", 5000);
	b.c.batchFrom = b.c.utter.until + QUIET_JUDGE_MS + 100;
	await b.c.judge(null);
	expect(b.sent).toEqual(["Delete the old test box"]);
	b.hear("and stop the simulator", 9000);
	b.c.batchFrom = b.c.utter.until + 500;
	await b.c.judge("hand-off");
	expect(b.sent).toEqual(["Delete the old test box", "and stop the simulator"]);
	b.stop();
});

test("a task's reply becomes the topic only when no card or decision is open", async () => {
	const { c, stop } = fakeCall(() => null);
	c.view.state = "live";
	const reply = {
		kind: "agent" as const,
		id: "a1",
		task: { taskId: "t2", name: "Disk usage", agentId: null },
		text: "Done.",
		at: 0,
	};
	const decision = {
		kind: "decision",
		taskId: "t",
		questionId: "q",
		name: "Email",
		text: "Switch?",
		options: [{ label: "Switch", recommended: true }],
		at: Date.now(),
	};
	c.topic = decision;
	await c.nudge(reply);
	expect(c.topic).toBe(decision);
	c.topic = null;
	await c.nudge(reply);
	expect(c.topic).toMatchObject({ kind: "reply", taskId: "t2", name: "Disk usage" });
	expect(c.said.at(-1)?.text).toBe("The disk task says it is done.");
	stop();
});

test("go ahead picks a decision's button: its options reach the gate, the chat's way answers", async () => {
	jest.useFakeTimers();
	const { call, c, judged, leadAnswered, hear, stop } = fakeCall(() => [
		{ p: 0.95, send: true, kind: "lead", onTopic: true, answer: null, choice: 0 },
	]);
	const routed: unknown[] = [];
	call.answerWith(async (input) => {
		routed.push(input);
	});
	c.topic = {
		kind: "decision",
		taskId: "t",
		questionId: "q",
		name: "Email",
		text: "Switch?",
		options: [{ label: "Switch", recommended: true }, { label: "Keep" }],
		at: Date.now(),
	};
	hear("Go ahead.", 0);
	await c.judge(null);
	expect(judged[0]?.opts?.topic?.options?.map((o) => o.label)).toEqual(["Switch", "Keep"]);
	expect(call.view.approving?.text).toBe("Email: Switch");
	jest.advanceTimersByTime(UNDO_MS + 1);
	expect(routed).toEqual([{ taskId: "t", questionId: "q", answer: "Switch" }]);
	expect(leadAnswered).toEqual([]);
	stop();
	jest.useRealTimers();
});

test("a hand-off cancels the voice's own acknowledgement; the call acknowledges only what went", async () => {
	const { c, hear, stop } = fakeCall((p) => p.map((x) => (x.startsWith("Mom") ? nobodys : lead())));
	const out: [string, string | null, string][] = [];
	c.dc = {
		readyState: "open",
		send: (d: string) => {
			const e = JSON.parse(d);
			out.push([e.type, e.delegation_id, e.content]);
		},
	};
	c.onVoice({ type: "session.delegation.created", delegation: { id: "d1" } });
	expect(out).toEqual([["session.thinking.append", "d1", ""]]);
	// Sent: the hand-off is noted as in progress, and "One sec." is a line of
	// its own, never the hand-off's commentary (GPT-Live takes that as a
	// result and went on to invent one).
	hear("Start a task for disk usage", 0);
	await c.judge("d1");
	expect(out.slice(1)).toEqual([
		["session.thinking.append", "d1", IN_PROGRESS],
		["session.commentary.append", null, "One sec."],
	]);
	// Held: no acknowledgement, the voice is told to say nothing.
	hear("Mom, hold on", 9000);
	c.batchFrom = c.utter.until + UTTERANCE_GAP_MS + 1;
	await c.judge("d2");
	expect(out.slice(3).map((e) => e[0])).toEqual(["session.thinking.append"]);
	stop();
});
