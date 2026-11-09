// Real-target smoke test, deliberately excluded from bun's *.test.ts suite.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const dir = process.env.DESKTOP_CONTROL_DIR ?? join(homedir(), ".desktop-control");
const token = (await readFile(join(dir, "desktop-token"), "utf8")).trim();
const url = process.env.DESKTOP_MCP_URL ?? "http://127.0.0.1:6080/mcp";
const scratch = await mkdtemp(join(tmpdir(), "desktop-smoke-"));
const document = join(scratch, "proof.txt");
console.log(`Evidence directory: ${scratch}`);
await writeFile(document, "");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function call(name, args) {
	const res = await fetch(url, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
	assert.equal(res.status, 200);
	const reply = await res.json();
	assert(!reply.error, JSON.stringify(reply.error));
	assert(!reply.result.isError, JSON.stringify(reply.result));
	return reply.result;
}
const { lease } = JSON.parse(
	(await call("control", { action: "acquire", label: "Linux smoke test" })).content[0].text,
);
const editor = spawn("mousepad", ["--disable-server", document], {
	env: {
		...process.env,
		DISPLAY: process.env.DISPLAY ?? ":99",
		XDG_CONFIG_HOME: join(scratch, "config"),
		XDG_DATA_HOME: join(scratch, "data"),
		XDG_CACHE_HOME: join(scratch, "cache"),
		GSETTINGS_BACKEND: "memory",
	},
	stdio: "ignore",
});
let editorError;
editor.on("error", (e) => {
	editorError = e;
});
try {
	await wait(1000);
	if (editorError) throw editorError;
	// Isolated app settings avoid Mousepad's session-recovery prompt. Arrange
	// only our own process's window; every edit below goes through MCP.
	const env = { ...process.env, DISPLAY: process.env.DISPLAY ?? ":99" };
	const window = execFileSync(
		"xdotool",
		["search", "--sync", "--onlyvisible", "--pid", String(editor.pid)],
		{ env, encoding: "utf8", timeout: 5000 },
	)
		.trim()
		.split("\n")[0];
	assert(window, "Mousepad window did not appear");
	execFileSync(
		"xdotool",
		[
			"windowmove",
			window,
			"0",
			"0",
			"windowsize",
			window,
			"1200",
			"650",
			"windowraise",
			window,
			"windowactivate",
			"--sync",
			window,
		],
		{ env, timeout: 5000 },
	);
	await wait(200);
	const input = (action, args = {}) => call("computer", { action, lease, ...args });
	await input("left_click", { x: 150, y: 180 });
	const activePid = execFileSync("xdotool", ["getactivewindow", "getwindowpid"], {
		env,
		encoding: "utf8",
	}).trim();
	assert.equal(activePid, String(editor.pid), "Our editor must own focus before typing");
	const expected =
		"Desktop MCP first build\n" +
		"Long text reaches the native app through real X11 key events. ".repeat(5) +
		"\nUnicode: café, naïve, Ελληνικά, 日本語.\n";
	await input("type", { text: expected });
	await input("key", { key: "Control+s" });
	let actual = "";
	for (let i = 0; i < 30; i++) {
		actual = await readFile(document, "utf8");
		if (actual === expected) break;
		await wait(100);
	}
	const shot = await call("computer", { action: "screenshot" });
	const png = shot.content.find((c) => c.type === "image");
	assert(png);
	await writeFile(join(scratch, "screen.png"), Buffer.from(png.data, "base64"));
	assert.equal(actual, expected);
	// Short text survives xdotool's own rebinding by luck; check that each
	// non-ASCII character had a keycode of its own instead.
	const keymap = execFileSync("xmodmap", ["-pk"], { env, encoding: "utf8" });
	for (const c of new Set(expected.match(/[^\x20-\x7e\n]/gu))) {
		const cp = c.codePointAt(0);
		const sym = `0x${(cp >= 0x100 ? 0x1000000 + cp : cp).toString(16).padStart(4, "0")}`;
		assert(keymap.includes(sym), `${c} (${sym}) was not bound to a keycode`);
	}
	console.log(
		`PASS: native click, multilingual typing on bound keycodes, Control+s, exact saved bytes and PNG. Evidence: ${scratch}`,
	);
} finally {
	await call("control", { action: "release", lease });
	editor.kill();
}
