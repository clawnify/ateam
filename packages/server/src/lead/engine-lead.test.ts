// A box's own Lead, served over the engine's RPC the way the phone reaches it:
// serveRpc with the extension, a fake connection, and a fake `claude`.
import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
	CH,
	type ClientFrame,
	LEAD_CH,
	LEAD_EVENT,
	type LeadFile,
	type LeadSnapshot,
	type ServerFrame,
} from "@ateam/protocol";
import type { Dispatcher } from "../dispatcher";
import type { Engine } from "../engine";
import { serveRpc } from "../rpc";
import { engineLead, MAX_LEAD_ATTACH_BYTES } from "./engine-lead";
import { leadPrompt } from "./session";
import { createLeadTools } from "./tools";

class FakeClaude extends EventEmitter {
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	written: Record<string, unknown>[] = [];
	constructor(public args: string[]) {
		super();
		this.stdin.on("data", (d: Buffer) => {
			for (const line of d.toString().split("\n")) if (line) this.written.push(JSON.parse(line));
		});
	}
	say(...lines: unknown[]) {
		for (const l of lines) this.stdout.write(`${JSON.stringify(l)}\n`);
	}
	killed = false;
	kill() {
		this.killed = true;
		return true;
	}
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function fakeEngine() {
	const listeners: ((t: unknown) => void)[] = [];
	return {
		engine: {
			on: (event: string, l: (t: unknown) => void) => {
				if (event === "taskUpdated") listeners.push(l);
				return () => {};
			},
		} as unknown as Engine,
		dispatcher: {
			methods: [CH.projectsList],
			handle: async (method: string) => {
				if (method === CH.projectsList) return [];
				throw new Error(`Unknown method: ${method}`);
			},
			release: () => {},
		} as unknown as Dispatcher,
	};
}

/** One client connection: requests in, replies and events out. */
function connect(ext: ReturnType<typeof engineLead>) {
	const { engine, dispatcher } = fakeEngine();
	const sent: ServerFrame[] = [];
	let onFrame: (f: ClientFrame) => void = () => {};
	serveRpc(engine, dispatcher, { send: (f) => sent.push(f), onFrame: (h) => (onFrame = h) }, [ext]);
	let n = 0;
	const call = async (method: string, ...args: unknown[]) => {
		const id = ++n;
		onFrame({ t: "req", id, method, args });
		for (let i = 0; i < 100; i++) {
			const res = sent.find((f) => f.t === "res" && f.id === id);
			if (res?.t === "res") {
				if (!res.ok) throw new Error(res.error);
				return res.result;
			}
			await tick();
		}
		throw new Error(`no reply to ${method}`);
	};
	const events = () => sent.filter((f) => f.t === "evt" && f.event === LEAD_EVENT);
	return { call, sent, events };
}

function setup(idleStopMs?: number) {
	const dir = join(mkdtempSync(join(tmpdir(), "box-lead-")), "lead");
	const procs: FakeClaude[] = [];
	const ext = engineLead({
		...fakeEngine(),
		dir,
		...(idleStopMs ? { idleStopMs } : {}),
		spawnClaude: (args) => {
			const p = new FakeClaude(args);
			procs.push(p);
			return p as unknown as ChildProcess;
		},
	});
	return { dir, procs, ext };
}

describe("a box's own Lead over the engine's RPC", () => {
	it("costs nothing until called, then pushes its events to that connection only", async () => {
		const { dir, procs, ext } = setup();
		expect(existsSync(dir)).toBe(false);
		const phone = connect(ext);
		const desktop = connect(ext);
		// The desktop's own calls never subscribe it.
		expect(await desktop.call(CH.projectsList)).toEqual([]);

		// A read (the phone does one on every connect) starts nothing: once
		// started, a Lead's folder makes the engine start it at every boot.
		const snap = (await phone.call(LEAD_CH.snapshot, { tail: 20 })) as LeadSnapshot;
		expect(snap).toEqual({ items: [], draft: "", busy: false, auto: false });
		expect(existsSync(dir)).toBe(false);
		expect(procs).toHaveLength(0);

		await phone.call(LEAD_CH.send, "brief me");
		expect(existsSync(dir)).toBe(true);
		const p = procs[0] as FakeClaude;
		// The box's words, not the Mac's: the user may be on either.
		const prompt = p.args[p.args.indexOf("--append-system-prompt") + 1] ?? "";
		expect(prompt).toContain("on their phone or on their Mac");
		expect(prompt).toContain("this box's tasks only");
		expect(prompt).not.toContain("Mac or on");
		p.say(
			{ type: "system", subtype: "init", session_id: "s1" },
			{ type: "assistant", message: { content: [{ type: "text", text: "All quiet." }] } },
			{ type: "result", subtype: "success" },
		);
		await tick();
		const kinds = phone
			.events()
			.map((f) => (f.t === "evt" ? (f.payload as { type: string }).type : ""));
		expect(kinds).toContain("item");
		expect(kinds).toContain("busy");
		expect(desktop.events()).toHaveLength(0);
		ext.dispose();
	});

	it("takes a photo as base64 and hands its path to the Lead", async () => {
		const { procs, ext } = setup();
		const phone = connect(ext);
		const file = (await phone.call(
			LEAD_CH.attachBytes,
			"IMG_1.jpg",
			Buffer.from("jpeg bytes").toString("base64"),
		)) as LeadFile;
		expect(file).toMatchObject({ name: "IMG_1.jpg", image: true, size: 10 });
		expect(readFileSync(file.path, "utf8")).toBe("jpeg bytes");
		await phone.call(LEAD_CH.send, "what is this?", [file.path]);
		await tick();
		const content = (procs[0]?.written[0] as { message: { content: string } }).message.content;
		expect(content).toBe(`what is this?\n\nAttached files:\n- ${file.path}`);
		ext.dispose();
	});

	it("answers an emoji (v28) for an agent's reply, and refuses one for a reply it doesn't have", async () => {
		const { ext } = setup();
		const desktop = connect(ext);
		// Routed to the Lead, not to the dispatcher's "Unknown method".
		await expect(desktop.call(LEAD_CH.react, "gone", "👍")).rejects.toThrow(
			"That reply is no longer in the chat.",
		);
		await expect(desktop.call(LEAD_CH.react, 7, "👍")).rejects.toThrow("The reply must be text.");
		ext.dispose();
	});

	it("switches Auto mode from the phone, and says so to the connection", async () => {
		const { ext } = setup();
		const phone = connect(ext);
		await phone.call(LEAD_CH.setAuto, true);
		expect(((await phone.call(LEAD_CH.snapshot)) as LeadSnapshot).auto).toBe(true);
		expect(phone.events().map((f) => (f.t === "evt" ? f.payload : null))).toContainEqual({
			type: "auto",
			auto: true,
		});
		// Anything but a real true is off.
		await phone.call(LEAD_CH.setAuto, "yes");
		expect(((await phone.call(LEAD_CH.snapshot)) as LeadSnapshot).auto).toBe(false);
		ext.dispose();
	});

	it("tells sleep control when the chat is in use, but not when it is only read", async () => {
		const { procs, ext } = setup();
		const phone = connect(ext);
		await phone.call(LEAD_CH.snapshot); // the phone opening the chat
		expect(ext.activity()).toEqual({ working: false, lastUsedAt: null });

		const before = Date.now();
		await phone.call(LEAD_CH.send, "clean up the branches");
		const used = ext.activity();
		expect(used.working).toBe(true);
		expect(used.lastUsedAt).toBeGreaterThanOrEqual(before);

		// Waiting on the user's answer is not work, as for a task's agent.
		const p = procs[0] as FakeClaude;
		p.say(
			{ type: "system", subtype: "init", session_id: "s1" },
			{
				type: "control_request",
				request_id: "r1",
				request: {
					subtype: "can_use_tool",
					tool_name: "Bash",
					input: { command: "git branch -D x" },
				},
			},
		);
		await tick();
		expect(ext.activity().working).toBe(false);
		await phone.call(LEAD_CH.permission, "r1", "allow");
		expect(ext.activity().working).toBe(true);
		p.say({ type: "result", subtype: "success" });
		await tick();
		expect(ext.activity().working).toBe(false);
		ext.dispose();
	});

	it("refuses what the network must not get through", async () => {
		const { ext } = setup();
		const phone = connect(ext);
		const big = "A".repeat(Math.ceil(((MAX_LEAD_ATTACH_BYTES + 10) * 4) / 3));
		await expect(phone.call(LEAD_CH.attachBytes, "big.mov", big)).rejects.toThrow("over 10 MB");
		// Only files attached in this chat.
		await expect(phone.call(LEAD_CH.send, "read this", ["/etc/hosts"])).rejects.toThrow(
			"not a file the user attached",
		);
		await expect(phone.call(LEAD_CH.permission, "x", "yes please")).rejects.toThrow(
			"Unknown answer",
		);
		ext.dispose();
	});
});

describe("a box's Lead stays light", () => {
	it("stops its claude when idle, and the next message resumes the same conversation", async () => {
		const { procs, ext } = setup(30);
		const phone = connect(ext);
		await phone.call(LEAD_CH.send, "first");
		const first = procs[0] as FakeClaude;
		first.say(
			{ type: "system", subtype: "init", session_id: "s-idle" },
			{ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
			{ type: "result", subtype: "success" },
		);
		await new Promise((r) => setTimeout(r, 80));
		expect(first.killed).toBe(true);
		await phone.call(LEAD_CH.send, "second");
		const second = procs[1] as FakeClaude;
		expect(second.args).toContain("--resume");
		expect(second.args[second.args.indexOf("--resume") + 1]).toBe("s-idle");
		ext.dispose();
	});

	it("never stops it mid-turn", async () => {
		const { procs, ext } = setup(20);
		const phone = connect(ext);
		await phone.call(LEAD_CH.send, "a long one");
		(procs[0] as FakeClaude).say({ type: "system", subtype: "init", session_id: "s-busy" });
		await new Promise((r) => setTimeout(r, 60));
		expect((procs[0] as FakeClaude).killed).toBe(false);
		ext.dispose();
	});

	it("sends a phone the tail of a long conversation, and older pages on request", async () => {
		const { ext } = setup();
		const phone = connect(ext);
		for (const text of ["one", "two", "three"]) await phone.call(LEAD_CH.send, text);
		const whole = (await phone.call(LEAD_CH.snapshot)) as LeadSnapshot;
		expect(whole.items.map((i) => (i.kind === "user" ? i.text : i.kind))).toEqual([
			"one",
			"two",
			"three",
		]);
		expect(whole.more).toBeUndefined();
		const tail = (await phone.call(LEAD_CH.snapshot, { tail: 2 })) as LeadSnapshot;
		expect(tail.items).toHaveLength(2);
		expect(tail.more).toBe(true);
		const page = (await phone.call(LEAD_CH.older, tail.items[0]?.id, 10)) as {
			items: { id: string }[];
			more: boolean;
		};
		expect(page.items.map((i) => i.id)).toEqual([whole.items[0]?.id ?? ""]);
		expect(page.more).toBe(false);
		// The state alone, for a composer that only needs Auto and busy.
		expect(((await phone.call(LEAD_CH.snapshot, { tail: 0 })) as LeadSnapshot).items).toEqual([]);
		ext.dispose();
	});
});

describe("a call with the box's Lead (v33, Ateam Go)", () => {
	/** This box's settings and keys in a folder of their own, and OpenAI faked. */
	async function withBoxKeys(
		run: (cfg: string, asked: { url: string; init: RequestInit }[]) => Promise<void>,
	) {
		const cfg = mkdtempSync(join(tmpdir(), "box-call-"));
		const env = { config: process.env.ATEAM_CONFIG, openRouter: process.env.OPENROUTER_API_KEY };
		const realFetch = globalThis.fetch;
		const asked: { url: string; init: RequestInit }[] = [];
		process.env.ATEAM_CONFIG = join(cfg, "settings.json");
		delete process.env.OPENROUTER_API_KEY;
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			asked.push({ url: String(url), init: init ?? {} });
			return Response.json({ session: { id: "sess_1" }, transport: { sdp: "v=0 answer" } });
		}) as typeof fetch;
		try {
			await run(cfg, asked);
		} finally {
			globalThis.fetch = realFetch;
			if (env.config === undefined) delete process.env.ATEAM_CONFIG;
			else process.env.ATEAM_CONFIG = env.config;
			if (env.openRouter !== undefined) process.env.OPENROUTER_API_KEY = env.openRouter;
		}
	}

	it("opens the voice session with the box's own key, which never reaches the phone", () =>
		withBoxKeys(async (cfg, asked) => {
			const { ext } = setup();
			const phone = connect(ext);
			// No key on this box: the phone hears what is missing, OpenAI isn't asked.
			await expect(phone.call(LEAD_CH.callStart, "v=0 offer", [])).rejects.toThrow(
				"This box has no OpenAI key for calls. Add yours from the box's card in Ateam Go",
			);
			expect(asked).toHaveLength(0);

			writeFileSync(join(cfg, "credentials.json"), JSON.stringify({ openAiApiKey: "sk-box-1234" }));
			const answer = await phone.call(LEAD_CH.callStart, "v=0 offer", [
				{ role: "user", text: "how is the search task doing?" },
			]);
			expect(answer).toEqual({ sdp: "v=0 answer", sessionId: "sess_1" });
			expect(JSON.stringify(answer)).not.toContain("sk-box");
			const req = asked[0];
			expect(req?.url).toBe("https://api.openai.com/v1/live/sessions");
			expect((req?.init.headers as Record<string, string>).Authorization).toBe(
				"Bearer sk-box-1234",
			);
			const body = JSON.parse(String(req?.init.body));
			expect(body.session.model).toBe("gpt-live-1");
			expect(body.session.delegation).toEqual({ type: "client", acknowledgement_delay_ms: 800 });
			expect(body.session.input).toEqual([
				{ role: "user", content: [{ type: "input_text", text: "how is the search task doing?" }] },
			]);
			expect(body.transport).toEqual({ type: "webrtc", sdp: "v=0 offer" });
			await expect(phone.call(LEAD_CH.callStart, 42)).rejects.toThrow(
				"The connection offer must be text.",
			);
			ext.dispose();
		}));

	it("judges what the call heard and words a task's reply, on the box", () =>
		withBoxKeys(async (_cfg, asked) => {
			const { ext } = setup();
			const phone = connect(ext);
			// No decision model on this box: no verdict, and the phone trusts the
			// voice's hand-off (lead-call's judgeBatch).
			expect(await phone.call(LEAD_CH.callJudge, ["Delete the old box."], "", {})).toBeNull();
			expect(await phone.call(LEAD_CH.callJudge, "not a list", "")).toBeNull();
			// An empty reply needs no model to say it.
			expect(await phone.call(LEAD_CH.callNudge, "Faster search", "")).toBe(
				'The task "Faster search" replied. It\'s in the chat.',
			);
			expect(asked).toHaveLength(0);
			ext.dispose();
		}));
});

describe("the box's words", () => {
	it("never send the user to a Mac or a dialog the phone doesn't have", () => {
		const tools = createLeadTools({ place: "box", handle: async () => [], machineOf: () => null });
		const text = [leadPrompt("box"), tools.instructions, JSON.stringify(tools.tools)].join("\n");
		expect(text).not.toContain("this Mac");
		expect(text).not.toMatch(/dialog/i);
		expect(text).not.toContain("mermaid");
	});
});
