import { describe, expect, test } from "bun:test";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import { trackMouseEncoding } from "../src/pty/snapshot-modes";

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
		expect(encoding()).toBe("");
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

	test("resetting the encoding, or a full reset, drops it", async () => {
		const { write, encoding } = setup();
		await write(OPENCODE_STARTUP);
		await write("\x1b[?1006l");
		expect(encoding()).toBe("");
		await write("\x1b[?1006h");
		await write("\x1bc");
		expect(encoding()).toBe("");
	});

	test("xterm's own handling still runs (handlers fall through)", async () => {
		const { term, write } = setup();
		await write("\x1b[?1003h\x1b[?1006h");
		expect(term.modes.mouseTrackingMode).toBe("any");
		await write("\x1b[?1003l");
		expect(term.modes.mouseTrackingMode).toBe("none");
	});
});
