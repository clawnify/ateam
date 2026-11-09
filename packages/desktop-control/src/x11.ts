import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** Text to type as xdotool calls: Return/Tab as keys (LF is not Return in
 * libxdo), the rest in pieces of at most `max` code points. libxdo spends the
 * full delay on every character, so 4000 characters at 12ms is 48s before X
 * round trips, close to run()'s 60s kill; 500 stays near 6s. */
export function typingParts(text: string, max = 500): ({ key: string } | { text: string })[] {
	const parts: ({ key: string } | { text: string })[] = [];
	for (const part of text.replace(/\r\n?/g, "\n").split(/([\n\t])/)) {
		if (!part) continue;
		if (part === "\n" || part === "\t") {
			parts.push({ key: part === "\n" ? "Return" : "Tab" });
			continue;
		}
		const chars = Array.from(part);
		for (let i = 0; i < chars.length; i += max)
			parts.push({ text: chars.slice(i, i + max).join("") });
	}
	return parts;
}

export class X11Desktop {
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
					// Dynamic Unicode keymaps need the normal 12ms delay, or GTK loses keys.
					for (const part of typingParts(args.text)) {
						if ("key" in part)
							await run("xdotool", ["key", "--clearmodifiers", part.key], this.display, signal);
						else
							await run(
								"xdotool",
								["type", "--clearmodifiers", "--delay", "12", "--file", "-"],
								this.display,
								signal,
								part.text,
							);
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
	async resetInput(): Promise<void> {
		await run(
			"xdotool",
			["keyup", "--delay", "0", ...Array.from({ length: 248 }, (_, i) => String(i + 8))],
			this.display,
		);
		await run("xdotool", ["mouseup", "1", "mouseup", "2", "mouseup", "3"], this.display);
	}
}
