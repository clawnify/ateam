#!/usr/bin/env node
// The `ateam` server CLI — the piece that runs on a remote box (your Hetzner
// server) so a client can drive the engine over SSH.
//
//   ateam daemon        Persistent engine: SQLite + hooks + the board state
//                       machine + RPC, listening on a unix socket. Owns all
//                       durable state; outlives any client. Run under Node with
//                       node-pty/better-sqlite3 native modules built for it.
//   ateam attach --stdio  Stateless relay: pipes stdin⇄the daemon socket. This
//                       is what `ssh host ateam attach --stdio` execs — it holds
//                       no state, so its death never touches the daemon or its
//                       PTY sessions. The far-end client frames JSON-RPC; this
//                       just moves bytes.
//
// shortcut: dist/runtime is box-packaging work — the daemon needs Node (not Bun:
// better-sqlite3 can't load under Bun) with native modules rebuilt, the PTY
// daemon bundle (ATEAM_PTY_DAEMON) shipped beside it, and this TS compiled to
// JS. Wire that up when standing the first server; the logic below is runtime-
// agnostic.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, realpathSync, unlinkSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createDispatcher } from "./dispatcher";
import { createEngine } from "./engine";
import { serveRpc } from "./rpc";
import { socketServerTransport } from "./transport/socket";

const SOCK = process.env.ATEAM_RPC_SOCK ?? join(homedir(), ".ateam", "rpc.sock");

// Absolute path to THIS running cli.js. Do NOT use import.meta.url: the bundler
// inlines it to the BUILD-TIME source path (the build host's filesystem), so the
// daemon paths derived from it would point at a machine that isn't this one. The
// executing script's own path (realpath-resolved, so a `bin` symlink still lands
// in the dist dir beside daemon.js) is what's portable across boxes.
const SELF = process.argv[1] ? realpathSync(process.argv[1]) : "";

async function runDaemon(): Promise<void> {
	const dataDir = process.env.ATEAM_DATA_DIR ?? join(homedir(), ".ateam");
	// The PTY daemon bundle (node-pty + xterm). Shipped beside the ateam bin on
	// the server; overridable for dev.
	const ptyDaemon = process.env.ATEAM_PTY_DAEMON ?? join(dirname(SELF), "daemon.js");

	const engine = await createEngine({ dataDir, daemonPath: ptyDaemon, execPath: process.execPath });
	engine.startLoops();
	const dispatcher = createDispatcher(engine);

	const dir = dirname(SOCK);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	// Clear a stale socket file; if a daemon were actually live, listen() below
	// would EADDRINUSE and we'd exit rather than steal its socket.
	try {
		if (existsSync(SOCK)) unlinkSync(SOCK);
	} catch {
		/* best-effort */
	}

	// Each client gets its own serveRpc over one connection; the engine (and its
	// PTY sessions) is shared and outlives any single client. The same handler
	// serves every listener — a net.Socket is a net.Socket whether it arrived over
	// the unix socket (a local `attach` relay / SSH) or a TCP port (a Tailscale
	// client), so socketServerTransport is transport-agnostic here.
	const onConnection = (sock: Socket): void => {
		serveRpc(engine, dispatcher, socketServerTransport(sock));
	};

	// allowHalfOpen: a one-shot client that sends a request then closes its write
	// side (EOF) must still receive the reply — without this the socket's read-end
	// 'end' auto-closes the write-end, dropping the response mid-flight.
	const server = createServer({ allowHalfOpen: true }, onConnection);
	server.on("error", (err) => {
		console.error(`[ateam] daemon error: ${err.message}`);
		process.exit(1);
	});
	server.listen(SOCK, () => console.log(`[ateam] daemon listening at ${SOCK}`));

	// Optional TCP listener, for network clients that can't run `ateam attach`
	// (the phone over Tailscale). Opt-in via env; the SAME onConnection serves it.
	// This socket carries NO auth of its own — auth is the network's job (a
	// Tailscale ACL, a private interface), exactly like the unix socket trusts
	// filesystem perms. So we REFUSE a wildcard bind: exposing an unauthenticated
	// engine on 0.0.0.0 would hand it to the whole network. Bind to an explicit
	// private address (the Tailscale IP) only.
	const tcpPort = process.env.ATEAM_TCP_PORT;
	const tcpHost = process.env.ATEAM_TCP_HOST;
	if (tcpPort) {
		const port = Number(tcpPort);
		if (!tcpHost || tcpHost === "0.0.0.0" || tcpHost === "::" || !Number.isInteger(port) || port <= 0) {
			console.error(
				"[ateam] refusing TCP listen: set ATEAM_TCP_HOST to an explicit private address " +
					"(e.g. the Tailscale IP) and ATEAM_TCP_PORT to a port — never a wildcard bind",
			);
			process.exit(1);
		}
		const tcpServer = createServer({ allowHalfOpen: true }, onConnection);
		tcpServer.on("error", (err) => {
			console.error(`[ateam] TCP listener error: ${err.message}`);
			process.exit(1);
		});
		tcpServer.listen(port, tcpHost, () =>
			console.log(`[ateam] daemon also listening on tcp://${tcpHost}:${port}`),
		);
	}

	// Connect to the PTY daemon in the BACKGROUND — don't block RPC on it. The
	// git/tasks/board surface serves immediately (a client's handshake shouldn't
	// wait out the PTY connect), and agent spawning reconnects lazily (PtyClient
	// respawns/reconnects on demand). Awaiting here is what previously stalled a
	// fresh box's first attach past its retry window.
	void engine.connectPty().catch((err) => {
		console.error(`[ateam] PTY daemon connect failed: ${(err as Error).message}`);
	});
}

function runAttach(): void {
	let spawnedDaemon = false;
	let retries = 0;
	const relay = (): void => {
		const sock = connect(SOCK);
		sock.once("connect", () => {
			process.stdin.pipe(sock);
			sock.pipe(process.stdout);
			process.stdin.on("end", () => sock.end());
			// Only a close AFTER we've actually connected ends the relay. Registering
			// this at the socket level would fire on every FAILED connect too (each
			// connect error emits 'error' THEN 'close'), exiting before the retry runs.
			sock.on("close", () => process.exit(0));
		});
		sock.once("error", (err: NodeJS.ErrnoException) => {
			// Both mean "no live daemon here": ECONNREFUSED = stale socket, nothing
			// listening; ENOENT = socket file absent (a fresh box's first attach).
			const noDaemon = err.code === "ECONNREFUSED" || err.code === "ENOENT";
			if (noDaemon) {
				if (!spawnedDaemon) {
					spawnedDaemon = true;
					// Start one detached, then poll until it's listening — first-run
					// startup (native module load + engine setup) takes a variable
					// moment, so retry with backoff rather than a single fixed wait.
					// Route its output to a log file: a detached daemon with no logs is
					// undebuggable on a remote box (and this is where its startup errors
					// surface).
					const dataDir = dirname(SOCK);
					if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
					const log = openSync(join(dataDir, "daemon.log"), "a");
					spawn(process.execPath, [SELF, "daemon"], {
						detached: true,
						stdio: ["ignore", log, log],
					}).unref();
				}
				if (retries < 40) {
					retries++;
					setTimeout(relay, 250); // up to ~10s for the daemon to come up
					return;
				}
			}
			console.error(`[ateam] attach failed: ${err.message}`);
			process.exit(1);
		});
	};
	relay();
}

const cmd = process.argv[2];
if (cmd === "daemon") {
	void runDaemon();
} else if (cmd === "attach") {
	// `--stdio` is the only (and default) mode today; accepted for forward-compat.
	runAttach();
} else {
	console.error("usage: ateam <daemon | attach --stdio>");
	process.exit(2);
}
