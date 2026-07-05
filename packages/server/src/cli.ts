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
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDispatcher } from "./dispatcher";
import { createEngine } from "./engine";
import { serveRpc } from "./rpc";
import { socketServerTransport } from "./transport/socket";

const SOCK = process.env.ATEAM_RPC_SOCK ?? join(homedir(), ".ateam", "rpc.sock");

async function runDaemon(): Promise<void> {
	const dataDir = process.env.ATEAM_DATA_DIR ?? join(homedir(), ".ateam");
	// The PTY daemon bundle (node-pty + xterm). Shipped beside the ateam bin on
	// the server; overridable for dev.
	const ptyDaemon =
		process.env.ATEAM_PTY_DAEMON ?? join(dirname(fileURLToPath(import.meta.url)), "daemon.js");

	const engine = await createEngine({ dataDir, daemonPath: ptyDaemon, execPath: process.execPath });
	// Best-effort: serve RPC (git/tasks/board) even if the PTY daemon isn't up
	// yet — agent spawning reconnects lazily, mirroring the desktop.
	try {
		await engine.connectPty();
	} catch (err) {
		console.error(`[ateam] PTY daemon connect failed: ${(err as Error).message}`);
	}
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

	const server = createServer((sock: Socket) => {
		// Each client gets its own serveRpc over one connection; the engine (and
		// its PTY sessions) is shared and outlives any single client.
		serveRpc(engine, dispatcher, socketServerTransport(sock));
	});
	server.on("error", (err) => {
		console.error(`[ateam] daemon error: ${err.message}`);
		process.exit(1);
	});
	server.listen(SOCK, () => console.log(`[ateam] daemon listening at ${SOCK}`));
}

function runAttach(): void {
	const relay = (spawnedDaemon: boolean): void => {
		const sock = connect(SOCK);
		sock.once("connect", () => {
			process.stdin.pipe(sock);
			sock.pipe(process.stdout);
			process.stdin.on("end", () => sock.end());
		});
		sock.once("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "ECONNREFUSED" && !spawnedDaemon) {
				// No daemon yet — start one detached and retry once.
				spawn(process.execPath, [fileURLToPath(import.meta.url), "daemon"], {
					detached: true,
					stdio: "ignore",
				}).unref();
				setTimeout(() => relay(true), 500);
				return;
			}
			console.error(`[ateam] attach failed: ${err.message}`);
			process.exit(1);
		});
		sock.on("close", () => process.exit(0));
	};
	relay(false);
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
