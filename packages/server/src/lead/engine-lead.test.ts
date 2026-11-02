// A box's own Lead, served over the engine's RPC the way the phone reaches it:
// serveRpc with the extension, a fake connection, and a fake `claude`.
import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
		// The box's words, not the Mac's.
		const prompt = p.args[p.args.indexOf("--append-system-prompt") + 1] ?? "";
		expect(prompt).toContain("phone");
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

describe("the box's words", () => {
	it("never send the user to a Mac or a dialog the phone doesn't have", () => {
		const tools = createLeadTools({ place: "box", handle: async () => [], machineOf: () => null });
		const text = [leadPrompt("box"), tools.instructions, JSON.stringify(tools.tools)].join("\n");
		expect(text).not.toContain("this Mac");
		expect(text).not.toMatch(/dialog/i);
		expect(text).not.toContain("mermaid");
	});
});
