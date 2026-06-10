// Standalone PTY daemon. Runs as a DETACHED process (the Electron binary
// launched with ELECTRON_RUN_AS_NODE=1 so node-pty's native module matches the
// arm64 ABI) and outlives the app, so terminals/agents survive an app restart.
//
// Protocol: newline-delimited JSON over a unix socket. Terminal bytes are
// base64-encoded in the `data` field. Clients connect, (re)attach by listing
// sessions + fetching each session's snapshot. Disconnecting a client never
// kills sessions — that's the whole point.
//
// The snapshot is NOT a raw byte buffer. Each session drives a headless xterm
// emulator that holds the full terminal STATE — screen contents plus every
// active mode (bracketed paste ?2004, focus reporting ?1004, alt screen ?1049,
// cursor keys, mouse tracking, …). On reattach we hand the renderer a
// serialized snapshot of that state, so a freshly-mounted xterm inherits the
// modes the agent set long ago. A raw ring buffer can't do this: an app enables
// bracketed paste once at startup, and once that `\x1b[?2004h` scrolls past the
// retained window every new view attaches with paste broken (newlines arrive as
// Enters instead of one bracketed block).
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import net from "node:net";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import * as pty from "node-pty";

const SOCK =
	process.env.ATEAM_PTY_SOCK || join(homedir(), ".ateam", "pty-daemon.sock");
const SCROLLBACK = 5000; // lines of scrollback the emulator (and snapshot) keeps
const IDLE_EXIT_MS = 10 * 60 * 1000; // exit if no sessions for 10 min

interface Session {
	id: string;
	proc: pty.IPty;
	// Headless emulator mirroring the PTY: source of truth for snapshot state.
	term: Terminal;
	serialize: SerializeAddon;
	exited: boolean;
	cwd: string;
	agentId: string;
	// Monotonic chunk counter. Stamped on every broadcast `data` and reported
	// with each snapshot so reattaching clients can dedupe (see PtyDataEvent).
	seq: number;
}

const sessions = new Map<string, Session>();
const clients = new Set<net.Socket>();
let idleTimer: NodeJS.Timeout | null = null;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

function broadcast(obj: unknown): void {
	const line = `${JSON.stringify(obj)}\n`;
	for (const c of clients) c.write(line);
}

function scheduleIdleExit(): void {
	if (idleTimer) clearTimeout(idleTimer);
	// Only shut down when there's nothing to keep alive AND no app connected.
	idleTimer = setTimeout(() => {
		if (sessions.size === 0 && clients.size === 0) process.exit(0);
	}, IDLE_EXIT_MS);
}

function spawnSession(m: {
	terminalId: string;
	shell: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	cols?: number;
	rows?: number;
	agentId?: string;
}): void {
	if (sessions.has(m.terminalId)) return;
	const cols = m.cols ?? 80;
	const rows = m.rows ?? 24;
	const proc = pty.spawn(m.shell, m.args, {
		name: "xterm-256color",
		cwd: m.cwd,
		env: m.env as { [key: string]: string },
		cols,
		rows,
	});
	const term = new Terminal({
		cols,
		rows,
		scrollback: SCROLLBACK,
		allowProposedApi: true,
	});
	const serialize = new SerializeAddon();
	term.loadAddon(serialize);
	const s: Session = {
		id: m.terminalId,
		proc,
		term,
		serialize,
		exited: false,
		cwd: m.cwd,
		agentId: m.agentId ?? "shell",
		seq: 0,
	};
	sessions.set(m.terminalId, s);
	if (idleTimer) clearTimeout(idleTimer);

	proc.onData((data) => {
		// Feed the emulator so it tracks screen + mode state for snapshots, and
		// stream the raw bytes live to attached clients.
		s.term.write(data);
		s.seq += 1;
		broadcast({
			t: "data",
			terminalId: m.terminalId,
			data: b64(data),
			seq: s.seq,
		});
	});
	proc.onExit(({ exitCode }) => {
		s.exited = true;
		broadcast({ t: "exit", terminalId: m.terminalId, exitCode });
		sessions.delete(m.terminalId);
		s.term.dispose();
		if (sessions.size === 0) scheduleIdleExit();
	});
}

function handleMessage(sock: net.Socket, m: Record<string, unknown>): void {
	switch (m.t) {
		case "spawn":
			spawnSession(
				m as unknown as Parameters<typeof spawnSession>[0],
			);
			break;
		case "write":
			sessions.get(m.terminalId as string)?.proc.write(unb64(m.data as string));
			break;
		case "resize": {
			const s = sessions.get(m.terminalId as string);
			if (s && !s.exited) {
				const cols = Math.max(1, m.cols as number);
				const rows = Math.max(1, m.rows as number);
				try {
					s.proc.resize(cols, rows);
					s.term.resize(cols, rows);
				} catch {
					/* ignore */
				}
			}
			break;
		}
		case "kill": {
			const s = sessions.get(m.terminalId as string);
			if (s && !s.exited) {
				try {
					s.proc.kill();
				} catch {
					/* gone */
				}
			}
			s?.term.dispose();
			sessions.delete(m.terminalId as string);
			if (sessions.size === 0) scheduleIdleExit();
			break;
		}
		case "snapshot": {
			const s = sessions.get(m.terminalId as string);
			const reply = (data: string, seq: number) =>
				sock.write(
					`${JSON.stringify({ t: "snapshot", id: m.id, data: b64(data), seq })}\n`,
				);
			if (!s) {
				reply("", 0);
				break;
			}
			// Capture the cut point synchronously: every chunk up to s.seq is
			// already written into s.term, so the serialized state below reflects
			// exactly bytes <= cutSeq. Chunks broadcast after this (seq > cutSeq)
			// are what the client replays on top, with no overlap.
			const cutSeq = s.seq;
			// xterm parses writes asynchronously; drain the queue with an empty
			// write so the serialized snapshot reflects the very latest bytes
			// (modes included) rather than a state a few frames stale.
			s.term.write("", () => reply(s.serialize.serialize(), cutSeq));
			break;
		}
		case "list":
			sock.write(
				`${JSON.stringify({
					t: "list",
					id: m.id,
					terminals: [...sessions.values()].map((s) => ({
						terminalId: s.id,
						cwd: s.cwd,
						agentId: s.agentId,
					})),
				})}\n`,
			);
			break;
		default:
			break;
	}
}

function startServer(): void {
	const dir = dirname(SOCK);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	const server = net.createServer((sock) => {
		clients.add(sock);
		// A connected app keeps the daemon alive.
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
		// On attach, tell the client which sessions are alive.
		sock.write(
			`${JSON.stringify({
				t: "hello",
				terminals: [...sessions.values()].map((s) => ({
					terminalId: s.id,
					cwd: s.cwd,
					agentId: s.agentId,
				})),
			})}\n`,
		);
		let buf = "";
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let nl: number;
			// biome-ignore lint/suspicious/noAssignInExpressions: stream framing
			while ((nl = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (line.trim()) {
					try {
						handleMessage(sock, JSON.parse(line));
					} catch {
						/* ignore malformed */
					}
				}
			}
		});
		const drop = () => {
			clients.delete(sock);
			// App disconnected: if nothing's running, schedule cleanup exit.
			if (sessions.size === 0 && clients.size === 0) scheduleIdleExit();
		};
		sock.on("close", drop);
		sock.on("error", drop);
	});

	server.on("error", (err) => {
		console.error("[pty-daemon] server error", err);
		process.exit(1);
	});
	server.listen(SOCK, () => {
		console.log(`[pty-daemon] listening at ${SOCK}`);
		scheduleIdleExit();
	});
}

// Singleton: if a daemon is already listening, exit; otherwise clean any stale
// socket and take over.
if (existsSync(SOCK)) {
	const probe = netConnect(SOCK);
	probe.on("connect", () => {
		probe.end();
		process.exit(0); // another daemon owns it
	});
	probe.on("error", () => {
		try {
			unlinkSync(SOCK);
		} catch {
			/* ignore */
		}
		startServer();
	});
} else {
	startServer();
}
