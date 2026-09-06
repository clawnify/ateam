import { describe, expect, test } from "bun:test";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import { trackMouseEncoding, withMouseEncoding } from "../src/pty/snapshot-modes";

// What OpenCode 1.18 sends at startup (captured from a real PTY): alt screen,
// bracketed paste, every mouse tracking mode, then SGR encoding.
const OPENCODE_STARTUP = "\x1b[?1049h\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";

function setup() {
	const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
	const serialize = new SerializeAddon();
	term.loadAddon(serialize);
	const encoding = trackMouseEncoding(term);
	const write = (s: string) => new Promise<void>((r) => term.write(s, r));
	const snapshot = () => serialize.serialize() + encoding();
	return { term, write, snapshot, serialize, encoding };
}

describe("snapshot mouse encoding", () => {
	test("serialize alone replays tracking but not the SGR encoding (the gap)", async () => {
		const { write, serialize } = setup();
		await write(OPENCODE_STARTUP);
		const s = serialize.serialize();
		expect(s).toContain("\x1b[?1003h");
		expect(s).not.toContain("\x1b[?1006h");
	});

	test("snapshot carries ?1006h once an app enabled SGR", async () => {
		const { write, snapshot } = setup();
		await write(OPENCODE_STARTUP);
		const s = snapshot();
		expect(s).toContain("\x1b[?1003h");
		expect(s).toContain("\x1b[?1006h");
	});

	test("a request split across PTY chunks is still seen", async () => {
		const { write, encoding } = setup();
		await write("\x1b[?1000h\x1b[?10");
		expect(encoding()).toBe("\x1b[?1006l"); // tracking on, nothing asked yet
		await write("06h");
		expect(encoding()).toBe("\x1b[?1006h");
	});

	test("combined params and the pixel variant", async () => {
		const { write, encoding } = setup();
		await write("\x1b[?1000;1006h");
		expect(encoding()).toBe("\x1b[?1006h");
		await write("\x1b[?1016h");
		expect(encoding()).toBe("\x1b[?1016h");
	});

	test("resetting the encoding states the default explicitly while tracking is on", async () => {
		const { write, encoding } = setup();
		await write(OPENCODE_STARTUP);
		await write("\x1b[?1006l");
		expect(encoding()).toBe("\x1b[?1006l");
		// Tracking off too: nothing to say about the mouse at all.
		await write("\x1b[?1000l\x1b[?1002l\x1b[?1003l");
		expect(encoding()).toBe("");
	});

	test("a full reset drops everything", async () => {
		const { write, encoding } = setup();
		await write(OPENCODE_STARTUP);
		await write("\x1bc");
		expect(encoding()).toBe("");
	});

	test("tracking without any encoding request is stated as the default", async () => {
		const { write, encoding } = setup();
		await write("\x1b[?1000h");
		expect(encoding()).toBe("\x1b[?1006l");
	});

	test("xterm's own handling still runs (handlers fall through)", async () => {
		const { term, write } = setup();
		await write("\x1b[?1003h\x1b[?1006h");
		expect(term.modes.mouseTrackingMode).toBe("any");
		await write("\x1b[?1003l");
		expect(term.modes.mouseTrackingMode).toBe("none");
	});
});

describe("withMouseEncoding (app-side fallback for old daemons)", () => {
	test("adds SGR when tracking is on and no encoding is stated", () => {
		const old = "\x1b[?1049h\x1b[?2004h\x1b[?1003hscreen";
		expect(withMouseEncoding(old)).toBe(`${old}\x1b[?1006h`);
	});

	test("leaves a snapshot alone when the daemon stated an encoding", () => {
		for (const stated of ["\x1b[?1006h", "\x1b[?1016h", "\x1b[?1006l"]) {
			const s = `\x1b[?1003hscreen${stated}`;
			expect(withMouseEncoding(s)).toBe(s);
		}
	});

	test("leaves a snapshot alone when the app does not own the mouse", () => {
		const s = "\x1b[?1049h\x1b[?2004hscreen";
		expect(withMouseEncoding(s)).toBe(s);
	});

	test("end to end: a snapshot from a tracking daemon never gets a second opinion", async () => {
		const { write, snapshot } = setup();
		await write(OPENCODE_STARTUP);
		await write("\x1b[?1006l");
		const s = snapshot();
		expect(s.endsWith("\x1b[?1006l")).toBe(true);
		expect(withMouseEncoding(s)).toBe(s);
	});
});
