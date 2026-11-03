import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LEAD_CH,
	LEAD_EVENT,
	type LeadEvent,
	type LeadSnapshot,
	type RpcClient,
} from "@ateam/protocol";
import {
	MAX_REMOTE_ATTACH_BYTES,
	PREVIEW_KEEP_MS,
	prunePreviews,
	REMOTE_TAIL,
	remoteLead,
} from "./remote";

const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

const snap = (text: string): LeadSnapshot => ({
	items: [{ kind: "assistant", id: text, text, at: 1 }],
	draft: "",
	busy: false,
	auto: false,
});

/** A box's connection: records calls, answers them, pushes Lead events. */
function fakeBox(answer: (method: string, args: unknown[]) => unknown = () => undefined) {
	const calls: { method: string; args: unknown[] }[] = [];
	const handlers = new Set<(p: unknown) => void>();
	const rpc: RpcClient = {
		call: async (method, args = []) => {
			calls.push({ method, args });
			return answer(method, args);
		},
		on: (event, h) => {
			if (event !== LEAD_EVENT) return () => {};
			handlers.add(h);
			return () => handlers.delete(h);
		},
	};
	return {
		rpc,
		calls,
		push: (e: LeadEvent) => {
			for (const h of handlers) h(e);
		},
		listeners: () => handlers.size,
	};
}

function setup(over: { version?: number } = {}) {
	let held: { rpc: RpcClient; version: number } | null = null;
	const emitted: LeadEvent[] = [];
	let connects = 0;
	let onConnect: () => void = () => {};
	const dir = mkdtempSync(join(tmpdir(), "remote-lead-"));
	const lead = remoteLead({
		box: "probe",
		link: () => held,
		connect: async () => {
			connects++;
			onConnect();
		},
		emit: (e) => emitted.push(e),
		preview: async () => "data:image/png;base64,AAAA",
		previewDir: join(dir, "previews"),
	});
	return {
		lead,
		dir,
		emitted,
		connects: () => connects,
		hold: (box: ReturnType<typeof fakeBox> | null) => {
			held = box ? { rpc: box.rpc, version: over.version ?? 28 } : null;
		},
		onConnect: (f: () => void) => {
			onConnect = f;
		},
	};
}

describe("the desktop's Lead on a box", () => {
	it("reads the last-seen conversation while the box isn't held, and never connects for it", async () => {
		const t = setup();
		expect(await t.lead.snapshot(50)).toEqual({ items: [], draft: "", busy: false, auto: false });
		expect(t.lead.connected()).toBe(false);
		expect(t.connects()).toBe(0);
	});

	it("subscribes when the box comes, reloads the conversation, and forwards its events", async () => {
		const t = setup();
		const box = fakeBox((m) => (m === LEAD_CH.snapshot ? snap("hello") : undefined));
		t.hold(box);
		t.lead.relink();
		await settle();
		expect(box.calls[0]).toEqual({ method: LEAD_CH.snapshot, args: [{ tail: REMOTE_TAIL }] });
		expect(t.emitted[0]).toEqual({ type: "reset", snapshot: snap("hello") });
		box.push({ type: "busy", busy: true });
		expect(t.emitted.at(-1)).toEqual({ type: "busy", busy: true });
		// Gone: the conversation as last seen stays readable.
		t.hold(null);
		t.lead.relink();
		expect(box.listeners()).toBe(0);
		expect(await t.lead.snapshot()).toMatchObject({ items: snap("hello").items, busy: true });
	});

	it("re-reads on a new connection after a drop, and leaves the old one", async () => {
		const t = setup();
		const first = fakeBox((m) => (m === LEAD_CH.snapshot ? snap("one") : undefined));
		t.hold(first);
		t.lead.relink();
		await settle();
		const second = fakeBox((m) => (m === LEAD_CH.snapshot ? snap("two") : undefined));
		t.hold(second);
		t.lead.relink();
		await settle();
		expect(first.listeners()).toBe(0);
		expect(second.listeners()).toBe(1);
		expect(t.emitted.at(-1)).toEqual({ type: "reset", snapshot: snap("two") });
	});

	it("connects the box (waking it) before sending, and says so when it can't", async () => {
		const t = setup();
		const box = fakeBox();
		t.onConnect(() => t.hold(box));
		await t.lead.send("status?", []);
		expect(t.connects()).toBe(1);
		expect(box.calls.map((c) => c.method)).toContain(LEAD_CH.send);
		const lone = setup();
		await expect(lone.lead.send("hi")).rejects.toThrow("probe isn't connected.");
	});

	it("sends a file from this Mac as bytes, keeps an image's preview, and refuses one over 10 MB", async () => {
		const t = setup();
		const box = fakeBox((m, args) =>
			m === LEAD_CH.attachBytes
				? { path: `/box/lead/${args[0]}`, name: args[0], size: 3, image: true }
				: undefined,
		);
		t.hold(box);
		const small = join(t.dir, "shot.png");
		writeFileSync(small, "png");
		const big = join(t.dir, "film.mov");
		writeFileSync(big, Buffer.alloc(MAX_REMOTE_ATTACH_BYTES + 1));
		const r = await t.lead.addPaths([small, big, join(t.dir, "nope.txt")]);
		expect(r.files.map((f) => f.path)).toEqual(["/box/lead/shot.png"]);
		expect(r.failed).toEqual([
			"film.mov is over 10 MB, too big to send to probe's Lead.",
			"nope.txt isn't a file.",
		]);
		const sent = box.calls.find((c) => c.method === LEAD_CH.attachBytes);
		expect(sent?.args).toEqual(["shot.png", Buffer.from("png").toString("base64")]);
		expect(t.lead.thumb("/box/lead/shot.png")).toBe("data:image/png;base64,AAAA");
		expect(t.lead.thumb("/box/lead/other.png")).toBeNull();
	});

	it("answers with an emoji only on a box that takes it (v28)", async () => {
		const old = setup({ version: 27 });
		const oldBox = fakeBox();
		old.hold(oldBox);
		expect(old.lead.canReact()).toBe(false);
		await expect(old.lead.react("r1", "👍")).rejects.toThrow("Update probe");
		expect(oldBox.calls.some((c) => c.method === LEAD_CH.react)).toBe(false);

		const t = setup();
		const box = fakeBox();
		t.hold(box);
		t.lead.relink();
		expect(t.lead.canReact()).toBe(true);
		await t.lead.react("r1", "👍");
		expect(box.calls.at(-1)).toEqual({ method: LEAD_CH.react, args: ["r1", "👍"] });
	});

	it("drops previews once the box no longer keeps their files (30 days)", () => {
		const dir = join(mkdtempSync(join(tmpdir(), "previews-")), "p");
		mkdirSync(dir);
		const old = join(dir, "old.txt");
		const fresh = join(dir, "fresh.txt");
		writeFileSync(old, "data:");
		writeFileSync(fresh, "data:");
		const now = Date.now();
		const past = (now - PREVIEW_KEEP_MS - 60_000) / 1000;
		utimesSync(old, past, past);
		prunePreviews(dir, now);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});

	it("tells the box which proposal was created or dismissed", async () => {
		const t = setup();
		const box = fakeBox();
		t.hold(box);
		await t.lead.proposal("p1", "created", "task-9");
		await t.lead.proposal("p2", "dismissed");
		expect(box.calls.filter((c) => c.method === LEAD_CH.proposal).map((c) => c.args)).toEqual([
			["p1", "created", "task-9"],
			["p2", "dismissed"],
		]);
	});
});
