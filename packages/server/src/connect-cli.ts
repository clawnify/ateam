#!/usr/bin/env bun
// A headless, interactive CLIENT for a remote Ateam engine — the terminal-only
// counterpart to the desktop app. It opens the SAME transport the desktop uses
// (`ssh <alias> ateam attach --stdio` → newline-JSON-RPC over stdio), handshakes,
// prints the box's live board (proving it's the engine's real state, not mock),
// then bridges your local TTY to a RAW PTY *on the server*.
//
// The spawned terminal is a login shell in a task's worktree ON THE BOX — a real
// server terminal. Type `claude` in it to launch the Claude Code TUI over the
// wire, exactly as if sitting at the box. Detach with Ctrl-] and the remote shell
// (and anything running in it, e.g. a claude session) lives on — reattach later
// with `--terminal <id>`, which replays the current screen via the PTY snapshot.
//
// Connection details (User, IdentityFile, ProxyJump, known_hosts) are OpenSSH's
// job via ~/.ssh/config — you pass an ssh alias, same as the desktop's connection
// picker. The transport is imported by its module path (not the @ateam/server
// barrel) so this client stays free of the engine's native modules (better-sqlite3
// / node-pty) and runs under plain bun/node.
//
//   bun packages/server/src/connect-cli.ts [alias] [--task <id>] [--terminal <id>] [--key <path>]
//   default alias: devbox
import { homedir } from "node:os";
import {
	type AteamApi,
	buildAteamApi,
	createRpcClient,
	type NativeClientApi,
	PROTOCOL_VERSION,
	type PtyDataEvent,
	type RpcClient,
	type SystemInfo,
	serverHandshake,
} from "@ateam/protocol";
import { type SshClient, sshClientTransport } from "./transport/ssh";

// ssh space-joins the remote args, so `bash -lc '…'` must arrive as ONE argv
// element (a login shell so nvm/agent-CLI PATH is set) execing the attach relay.
const REMOTE_ATTACH = "bash -lc 'exec ateam attach --stdio'";
const DETACH_BYTE = 0x1d; // Ctrl-] — frees the escape from the remote shell.
const HANDSHAKE_TIMEOUT_MS = 20_000; // ssh can hang on auth/unreachable with no error.

// The client-local slice of AteamApi (native dialogs / clipboard / windows) that
// no remote engine can serve. A headless terminal never invokes these, so a
// throwing stub is the honest total — buildAteamApi needs the shape, not the impl.
const headlessNative: NativeClientApi = {
	pathForFile: () => {
		throw new Error("no native filesystem in the terminal client");
	},
	pick: async () => null,
	pickFiles: async () => [],
	stageClipboardImage: async () => false,
	stageImagePath: async () => false,
	openProject: async () => {},
	boundProjectId: () => null,
};

interface Args {
	alias: string;
	taskId?: string;
	terminalId?: string;
	key?: string;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { alias: "devbox" };
	const rest = argv.slice(2);
	for (let i = 0; i < rest.length; i++) {
		const tok = rest[i];
		if (tok === "--task") args.taskId = rest[++i];
		else if (tok === "--terminal") args.terminalId = rest[++i];
		else if (tok === "--key") args.key = rest[++i];
		else if (tok && !tok.startsWith("-")) args.alias = tok;
	}
	return args;
}

/** Everything to stderr so stdout carries ONLY the raw PTY stream (pipe-friendly). */
function log(msg: string): void {
	process.stderr.write(`${msg}\n`);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
		p.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv);
	const sshFlags = [
		"-o",
		"BatchMode=yes",
		"-o",
		"ConnectTimeout=10",
		"-o",
		"StrictHostKeyChecking=accept-new",
	];
	if (args.key) sshFlags.push("-i", args.key.replace(/^~/, homedir()));

	log(`· connecting to ${args.alias} …`);
	const client = sshClientTransport(args.alias, [REMOTE_ATTACH], { sshFlags });
	const rpc: RpcClient = createRpcClient(client.transport);

	let info: SystemInfo;
	try {
		info = await withTimeout(serverHandshake(rpc), HANDSHAKE_TIMEOUT_MS, "handshake");
	} catch (err) {
		client.close();
		throw err;
	}
	if (info.protocolVersion !== PROTOCOL_VERSION) {
		client.close();
		throw new Error(
			`protocol mismatch: ${args.alias} speaks v${info.protocolVersion}, this client speaks v${PROTOCOL_VERSION} — update the older side`,
		);
	}
	const api = buildAteamApi(rpc, headlessNative);
	log(
		`· connected — engine protocol v${info.protocolVersion}; agents: ${info.agents.join(", ") || "none"}`,
	);

	// Resolve which server PTY to drive.
	let terminalId = args.terminalId;
	if (!terminalId) {
		// Dump the live board (proves real engine state) and pick a task to shell into.
		const projects = await api.projects.list();
		let taskId = args.taskId;
		for (const project of projects) {
			const tasks = await api.tasks.list(project.id);
			log(`\n▸ ${project.name}  ·  ${project.repoPath}`);
			for (const task of tasks) {
				const live = await api.pty.listForTask(task.id);
				const liveTag = live.length
					? `  (${live.length} live session${live.length === 1 ? "" : "s"})`
					: "";
				log(`    • ${task.name}  [${task.column}]${liveTag}  ${task.id}`);
				if (!taskId) taskId = task.id;
			}
		}
		if (!taskId) {
			client.close();
			throw new Error("no tasks on the box to open a shell in — create one from the app first");
		}
		log(`\n· spawning a raw login shell on the server, in task ${taskId} …`);
		const spawned = await api.pty.spawnShell({ taskId });
		terminalId = spawned.terminalId;
		log(`· server shell ready: ${terminalId}   (reattach later with --terminal ${terminalId})`);
	}

	await driveTerminal(api, client, terminalId);
}

/** Bridge the local TTY to the remote PTY: snapshot replay, live stream, raw input. */
async function driveTerminal(api: AteamApi, client: SshClient, terminalId: string): Promise<void> {
	const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);

	// Buffer live chunks until the snapshot is painted, then apply only newer ones
	// (seq-dedupe) so bytes the snapshot already reflects are never doubled.
	const buffered: PtyDataEvent[] = [];
	let applied = false;
	let lastSeq = -1;
	const offData = api.pty.onData((e) => {
		if (e.terminalId !== terminalId) return;
		if (!applied) {
			buffered.push(e);
			return;
		}
		if (e.seq > lastSeq) {
			lastSeq = e.seq;
			process.stdout.write(e.data);
		}
	});

	let done = false;
	const finish = (msg: string, code = 0): void => {
		if (done) return;
		done = true;
		offData();
		offExit();
		// Restore the terminal BEFORE anything else — never leave the user's shell
		// wedged in raw mode.
		if (isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
		process.stdin.pause();
		log(msg);
		client.close(); // ends the ssh relay; the remote shell + its sessions live on
		process.exit(code);
	};
	const offExit = api.pty.onExit((e) => {
		if (e.terminalId === terminalId)
			finish(`\n· remote shell exited (code ${e.exitCode})`, e.exitCode);
	});
	client.child.on("exit", () => finish("\n· ssh connection closed"));

	// Size the remote PTY to our window (TUIs like claude need correct cols/rows).
	const pushResize = (): void =>
		api.pty.resize(terminalId, process.stdout.columns ?? 80, process.stdout.rows ?? 24);
	if (isTTY) pushResize();

	// Snapshot replay: paint the server's current screen, then flush newer live chunks.
	try {
		const snap = await api.pty.snapshot(terminalId);
		if (snap.data) process.stdout.write(snap.data);
		lastSeq = snap.seq;
		for (const e of buffered) {
			if (e.seq > lastSeq) {
				lastSeq = e.seq;
				process.stdout.write(e.data);
			}
		}
	} finally {
		applied = true;
	}

	if (isTTY) {
		process.stdout.on("resize", pushResize);
		process.stdin.setRawMode(true);
		log(`\n· attached to server shell — type \`claude\` for the TUI. Ctrl-] to detach.\r\n`);
	}
	process.stdin.resume();
	process.stdin.on("data", (buf: Buffer) => {
		// Ctrl-] detaches locally (leaving the remote shell alive); every other byte
		// — arrows, Ctrl-C, Enter, paste — is forwarded raw to the server PTY.
		if (isTTY && buf.includes(DETACH_BYTE)) {
			finish(
				`\n· detached — remote shell ${terminalId} still running (reattach: --terminal ${terminalId})`,
			);
			return;
		}
		api.pty.write(terminalId, buf.toString("utf8"));
	});
	// Piped (non-TTY) input, for scripted use: after stdin ends, drain briefly then
	// detach. shortcut: fixed 1.5s drain — fine for scripts; interactive use is TTY.
	if (!isTTY)
		process.stdin.on("end", () => setTimeout(() => finish("\n· (piped input done)"), 1500));
}

if (import.meta.main) {
	main().catch((err) => {
		try {
			if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
		} catch {
			/* best-effort restore */
		}
		process.stderr.write(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	});
}
