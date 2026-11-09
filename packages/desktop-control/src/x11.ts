import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export function run(
	file: string,
	args: string[],
	display: string,
	signal?: AbortSignal,
	input?: string,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, {
			env: { ...process.env, DISPLAY: display, LC_ALL: "C.UTF-8" },
			stdio: ["pipe", "pipe", "pipe"],
			signal,
			timeout: 60_000,
		});
		const out: Buffer[] = [];
		let size = 0;
		let error = "";
		child.stdout.on("data", (b: Buffer) => {
			size += b.length;
			if (size > 24_000_000) child.kill("SIGKILL");
			else out.push(b);
		});
		child.stderr.on("data", (b) => {
			error = (error + b).slice(-2000);
		});
		// Reject on close, not abort's error event: the lock must outlive the child.
		let failure: Error | undefined;
		child.on("error", (e) => {
			failure = e;
		});
		child.stdin.on("error", () => {});
		child.stdin.end(input);
		child.on("close", (code) => {
			if (failure || code !== 0 || size > 24_000_000)
				reject(failure ?? new Error(`${file} failed (${code}): ${error}`));
			else resolve(Buffer.concat(out));
		});
	});
}

const aliases: Record<string, string> = {
	Control: "ctrl",
	Ctrl: "ctrl",
	Alt: "alt",
	Shift: "shift",
	Meta: "super",
	Super: "super",
	Enter: "Return",
	Backspace: "BackSpace",
	Esc: "Escape",
	Space: "space",
	ArrowLeft: "Left",
	ArrowRight: "Right",
	ArrowUp: "Up",
	ArrowDown: "Down",
	PageUp: "Prior",
	PageDown: "Next",
};
export function keySequence(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+){0,4}$/.test(value))
		throw new Error(
			"key must be an X11 key name or combination, e.g. Control+s, Return, Shift+Tab.",
		);
	return value
		.split("+")
		.map((k) => (Object.hasOwn(aliases, k) ? aliases[k] : k))
		.join("+");
}

/** `xmodmap -pk` → keycode → its non-empty keysyms. */
export function parseKeymap(out: string): Map<number, number[]> {
	const keymap = new Map<number, number[]>();
	for (const line of out.split("\n")) {
		const code = /^\s*(\d+)(?:\s|$)/.exec(line)?.[1];
		if (code)
			keymap.set(Number(code), (line.match(/0x[0-9a-f]+/gi) ?? []).map(Number).filter(Boolean));
	}
	return keymap;
}

export type KeyRun = { text: string; map: [keycode: number, keysym: number][]; overwrite: boolean };

/**
 * xdotool types a character missing from the keymap by rebinding ONE scratch
 * keycode for every key press and clearing it 3 ms later. An application that
 * reads the keymap after that has moved on types nothing or a neighbour; a
 * 4000-character multilingual text lost up to 137 of its 1237 non-ASCII characters.
 * Instead, each such character gets an empty keycode of its own before xdotool
 * runs, so xdotool finds it in the keymap and never rebinds. Text needing more
 * keycodes than are free is split into runs; a run that rebinds a keycode
 * already in use is marked `overwrite` so the caller can let the app catch up.
 */
export function planKeys(
	text: string,
	keymap: Map<number, number[]>,
	owned: Map<number, number>,
): KeyRun[] {
	const present = new Set<number>();
	const empty: number[] = [];
	for (const [code, syms] of keymap) {
		if (owned.has(code)) continue;
		if (!syms.length) empty.push(code);
		for (const sym of syms) present.add(sym);
	}
	empty.sort((a, b) => a - b);
	// Leave the lowest empty keycode to xdotool's scratch binding and the
	// highest to x11vnc's keysym additions for a viewer.
	const slots = [...empty.slice(1, -1), ...owned.keys()];
	const chars = Array.from(text);
	// The keysym xdotool itself would bind (xdo.c, _xdo_keysym_from_char).
	const syms = chars.map((c) => {
		const cp = c.codePointAt(0) ?? 0;
		const sym = cp >= 0x100 ? 0x1000000 + cp : cp;
		return cp >= 0xa0 && !present.has(sym) ? sym : 0;
	});
	if (!slots.length || !syms.some(Boolean)) return [{ text, map: [], overwrite: false }];
	const held = new Map(owned);
	// Rebind empty keycodes first, then the ones whose last key press is oldest.
	const lastUse = new Map<number, number>();
	const age = (code: number) => {
		const sym = held.get(code);
		return sym === undefined ? -2 : (lastUse.get(sym) ?? -1);
	};
	const runs: KeyRun[] = [];
	for (let start = 0; start < chars.length; ) {
		const need = new Set<number>();
		let end = start;
		for (; end < chars.length; end++) {
			const sym = syms[end];
			if (!sym || need.has(sym)) continue;
			if (need.size === slots.length) break;
			need.add(sym);
		}
		const holding = new Set(held.values());
		const spare = slots
			.filter((code) => !need.has(held.get(code) ?? 0))
			.sort((a, b) => age(a) - age(b));
		const map: KeyRun["map"] = [];
		let overwrite = false;
		for (const sym of need) {
			if (holding.has(sym)) continue;
			const code = spare.shift() as number;
			overwrite ||= held.has(code);
			held.set(code, sym);
			map.push([code, sym]);
		}
		runs.push({ text: chars.slice(start, end).join(""), map, overwrite });
		for (; start < end; start++) if (syms[start]) lastUse.set(syms[start] as number, start);
	}
	return runs;
}

// shortcut: a fixed pause before reusing a keycode. Measured on a 1-vCPU box,
// no pause at all lost nothing; 100 ms is margin for a busier app. An app that
// lags longer can still misread the end of the previous run. Binding a second
// keysym per keycode (Shift level) would halve the reuses if this gets slow.
const REBIND_SETTLE_MS = 100;
let warnedNoXmodmap = false;

export class X11Desktop {
	/** Keycodes this process bound for typing → keysym. Kept between calls. */
	private readonly owned = new Map<number, number>();
	constructor(private readonly display = ":99") {}
	async screenshot(): Promise<Buffer> {
		// Ubuntu's scrot/imlib cannot save to Node's socket-backed stdout pipe.
		// A private temporary directory also keeps screenshots out of shared paths.
		const dir = await mkdtemp(join(tmpdir(), "desktop-capture-"));
		try {
			const file = join(dir, "screen.png");
			await run("scrot", ["--pointer", "--file", file], this.display);
			const png = await readFile(file);
			if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
				throw new Error("scrot did not return PNG");
			return png;
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
	async action(args: Record<string, unknown>, signal: AbortSignal): Promise<void> {
		let command: string[];
		switch (args.action) {
			case "type": {
				if (
					typeof args.text !== "string" ||
					args.text.length > 4000 ||
					Array.from(args.text).some((c) => {
						const n = c.charCodeAt(0);
						return (n < 32 && ![9, 10, 13].includes(n)) || n === 127;
					})
				)
					throw new Error(
						"text must be at most 4000 characters, with only tab/newline control characters.",
					);
				try {
					for (const chunk of await this.keyRuns(args.text.replace(/\r\n?/g, "\n"), signal)) {
						if (chunk.map.length) {
							if (chunk.overwrite) await sleep(REBIND_SETTLE_MS, undefined, { signal });
							// Claimed first: the next call drops any an interrupted xmodmap missed.
							for (const [code, sym] of chunk.map) this.owned.set(code, sym);
							await run(
								"xmodmap",
								["-"],
								this.display,
								signal,
								chunk.map
									.map(([code, sym]) => `keycode ${code} = 0x${sym.toString(16)}`)
									.join("\n"),
							);
						}
						// LF is not Return in libxdo. Send newlines explicitly. Keep the
						// normal 12ms delay: faster typing loses keys in GTK.
						for (const part of chunk.text.split(/([\n\t])/)) {
							if (!part) continue;
							if (part === "\n" || part === "\t")
								await run(
									"xdotool",
									["key", "--clearmodifiers", part === "\n" ? "Return" : "Tab"],
									this.display,
									signal,
								);
							else
								await run(
									"xdotool",
									["type", "--clearmodifiers", "--delay", "12", "--file", "-"],
									this.display,
									signal,
									part,
								);
						}
					}
				} catch (error) {
					await this.resetInput();
					throw error;
				}
				return;
			}
			case "key":
				command = ["key", "--clearmodifiers", keySequence(args.key)];
				break;
			case "left_click":
			case "right_click":
			case "double_click":
			case "mouse_move": {
				const geometry = (await run("xdotool", ["getdisplaygeometry"], this.display, signal))
					.toString()
					.trim()
					.split(/\s+/)
					.map(Number);
				const [width = 0, height = 0] = geometry;
				if (!width || !height) throw new Error("Could not read display dimensions");
				const { x, y } = args;
				if (
					typeof x !== "number" ||
					typeof y !== "number" ||
					!Number.isInteger(x) ||
					!Number.isInteger(y) ||
					x < 0 ||
					y < 0 ||
					x >= width ||
					y >= height
				)
					throw new Error("x/y must be integers inside the full-resolution screenshot.");
				command = ["mousemove", "--sync", String(x), String(y)];
				if (args.action !== "mouse_move")
					command.push(
						"click",
						"--repeat",
						args.action === "double_click" ? "2" : "1",
						"--delay",
						"100",
						args.action === "right_click" ? "3" : "1",
					);
				break;
			}
			case "scroll": {
				const buttons: Record<string, string> = { up: "4", down: "5", left: "6", right: "7" };
				const button = buttons[String(args.direction)];
				const amount = args.amount ?? 3;
				if (
					typeof button !== "string" ||
					typeof amount !== "number" ||
					!Number.isInteger(amount) ||
					amount < 1 ||
					amount > 20
				)
					throw new Error("scroll needs direction up/down/left/right and amount 1..20.");
				command = ["click", "--repeat", String(amount), "--delay", "40", button];
				break;
			}
			default:
				throw new Error(`Unknown computer action: ${args.action}`);
		}
		try {
			await run("xdotool", command, this.display, signal);
		} catch (error) {
			// A failed/killed command can stop between key-down and key-up.
			await this.resetInput();
			throw error;
		}
	}
	private async keyRuns(text: string, signal: AbortSignal): Promise<KeyRun[]> {
		if (!/[\u00a0-\u{10ffff}]/u.test(text)) return [{ text, map: [], overwrite: false }];
		let keymap: Map<number, number[]>;
		try {
			keymap = parseKeymap((await run("xmodmap", ["-pk"], this.display, signal)).toString());
		} catch (error) {
			if (signal.aborted) throw error;
			// xdotool still types, with its per-character rebinding race.
			if (!warnedNoXmodmap)
				console.error(`Typing without reserved keycodes: ${(error as Error).message}`);
			warnedNoXmodmap = true;
			return [{ text, map: [], overwrite: false }];
		}
		// A restarted display starts from its default keymap.
		for (const [code, sym] of this.owned)
			if (!keymap.get(code)?.includes(sym)) this.owned.delete(code);
		return planKeys(text, keymap, this.owned);
	}
	/** Hand the keycodes bound for typing back to the display. */
	close(): void {
		if (!this.owned.size) return;
		const clear = [...this.owned.keys()].map((code) => `keycode ${code} =`).join("\n");
		this.owned.clear();
		run("xmodmap", ["-"], this.display, undefined, clear).catch(() => {});
	}
	async resetInput(): Promise<void> {
		await run(
			"xdotool",
			["keyup", "--delay", "0", ...Array.from({ length: 248 }, (_, i) => String(i + 8))],
			this.display,
		);
		await run("xdotool", ["mouseup", "1", "mouseup", "2", "mouseup", "3"], this.display);
	}
}
