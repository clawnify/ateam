import type { AteamApi, PtyDataEvent } from "@ateam/protocol";
import { Terminal } from "@xterm/xterm";
import { createRoot } from "react-dom/client";
import { TerminalView } from "../src/renderer/src/components/Terminal";
import "../src/renderer/src/index.css";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = (count: number) =>
	Array.from({ length: count }, (_, i) => String(i).padEnd(110, "x")).join("\r\n");
function element(selector: string) {
	const found = document.querySelector<HTMLElement>(selector);
	if (!found) throw new Error(`Missing fixture element: ${selector}`);
	return found;
}
const host = element("#root");
const root = createRoot(host);
let term: Terminal;
const open = Terminal.prototype.open;
Terminal.prototype.open = function (el) {
	term = this;
	open.call(this, el);
};
let terminalId = "first";
let seq = 0;
let listener: ((event: PtyDataEvent) => void) | undefined;
let snapshot = async () => ({ data: lines(400), seq });
window.ateam = {
	pty: {
		onData(fn: (event: PtyDataEvent) => void) {
			listener = fn;
			return () => {
				listener = undefined;
			};
		},
		snapshot: () => snapshot(),
		write() {},
		resize() {},
	},
} as unknown as AteamApi;

function send(data: string) {
	listener?.({ terminalId, data, seq: ++seq });
}
async function mount(id: string) {
	terminalId = id;
	root.render(<TerminalView terminalId={id} />);
	await delay(120);
}
function assert(ok: boolean, message: string) {
	if (!ok) throw new Error(message);
}
function bottom(label: string) {
	const { baseY, viewportY } = term.buffer.active;
	assert(baseY > 0 && viewportY === baseY, `${label}: viewport ${viewportY}, bottom ${baseY}`);
	const viewport = element(".xterm-viewport");
	const rowHeight = element(".xterm-screen").clientHeight / term.rows;
	assert(Math.abs(viewport.scrollTop - baseY * rowHeight) < 2, `${label}: DOM scrollbar is stale`);
}
async function scrollUp() {
	// Dispatch through xterm's real wheel handler (including our capture listener).
	element(".xterm").dispatchEvent(
		new WheelEvent("wheel", { deltaY: -150, bubbles: true, cancelable: true }),
	);
	await delay(100);
	assert(term.buffer.active.viewportY < term.buffer.active.baseY, "Wheel must scroll up");
	return term.buffer.active.viewportY;
}

async function run() {
	await mount("first");
	bottom("snapshot");
	// An ED3 redraw split across writes races native scroll events in xterm 5.
	// Vary the gap across a frame boundary; the unfixed view jumps to row zero.
	for (let i = 0; i < 40; i++) {
		send(`\r\n${lines(300)}`);
		await delay(50);
		send("\x1b[3J\x1b[H\x1b[2J");
		await delay(i % 20);
		send(lines(100));
		await delay(80);
		bottom(`split redraw ${i}`);
	}

	const reading = await scrollUp();
	send(`\r\n${lines(20)}`);
	await delay(100);
	assert(term.buffer.active.viewportY === reading, "Output must preserve manual scrollback");
	host.style.height = "400px";
	await delay(100);
	assert(term.buffer.active.viewportY < term.buffer.active.baseY, "Resize must preserve reading");
	term.scrollToBottom();
	await delay(100);
	host.style.height = "500px";
	await delay(100);
	bottom("resize while following");

	// Input arriving between a write and its deferred correction cancels it.
	send("\r\nqueued output");
	const interrupted = await scrollUp();
	await delay(100);
	assert(term.buffer.active.viewportY === interrupted, "Queued follow must yield to the wheel");
	await mount("second");
	bottom("switch task");
	await mount("first");
	bottom("switch back");
	host.style.display = "none";
	await delay(100);
	send(`\r\n${lines(20)}`);
	await delay(100);
	host.style.display = "flex";
	await delay(120);
	bottom("reveal after hidden output");

	// A late snapshot from the previous task must not write to a disposed xterm.
	let resolveOld!: (value: { data: string; seq: number }) => void;
	snapshot = () =>
		new Promise((resolve) => {
			resolveOld = resolve;
		});
	await mount("slow");
	const staleTerm = term;
	snapshot = async () => ({ data: lines(400), seq });
	await mount("current");
	let staleWrites = 0;
	staleTerm.write = () => {
		staleWrites++;
	};
	resolveOld({ data: "obsolete snapshot", seq });
	await delay(100);
	assert(staleWrites === 0, "Late snapshot must not write to a disposed terminal");
	bottom("late snapshot");
	send("\r\npending at unmount");
	root.unmount();
	let staleScrolls = 0;
	term.scrollToBottom = () => {
		staleScrolls++;
	};
	await delay(100);
	assert(staleScrolls === 0, "Unmount must cancel pending scroll corrections");
	return "PASS: split redraws, manual scrolling, resize, task switches, hidden output and teardown";
}

(window as unknown as { runTerminalScrollTests: typeof run }).runTerminalScrollTests = run;
