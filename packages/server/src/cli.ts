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
import { type AggregateBackend, type BoxWake, CH, createAggregate } from "@ateam/protocol";
import type { Dispatcher } from "./dispatcher";
import { dotfilesFor } from "./dotfiles";
import { createDispatcher } from "./dispatcher";
import type { Engine } from "./engine";
import { createEngine } from "./engine";
import { engineLead } from "./lead/engine-lead";
import { BoxLinks } from "./links";
import { Pairings } from "./pairing";
import {
	LinkLimiter,
	LiveConnections,
	type PairingGuard,
	RedeemLimiter,
	type RpcExtension,
	serveRpc,
} from "./rpc";
import { hasBoxChoice, idleSleepMinutesOf, readSettings, updateSettings } from "./settings-file";
import {
	alwaysOnProvider,
	detectSleepDriver,
	providerReport,
	type SleepControl,
	startSleepControl,
} from "./sleep";
import { reachableWsAddr } from "./tailnet";
import { socketServerTransport } from "./transport/socket";
import { wsServerTransport } from "./transport/ws";
import { resolveWsAddr, WS_ADDR_FILE } from "./ws-addr";
import { startWsListener } from "./ws-listener";

const SOCK = process.env.ATEAM_RPC_SOCK ?? join(homedir(), ".ateam", "rpc.sock");
// Where a daemon started from here keeps its state. Shared with the notice
// `attach` prints before auto-spawning, so the two can never disagree.
const DATA_DIR = process.env.ATEAM_DATA_DIR ?? join(homedir(), ".ateam");

// Absolute path to THIS running cli.js. Do NOT use import.meta.url: the bundler
// inlines it to the BUILD-TIME source path (the build host's filesystem), so the
// daemon paths derived from it would point at a machine that isn't this one. The
// executing script's own path (realpath-resolved, so a `bin` symlink still lands
// in the dist dir beside daemon.js) is what's portable across boxes.
const SELF = process.argv[1] ? realpathSync(process.argv[1]) : "";

// Set once a provider that can put this box to sleep is found (see maybeStartIdleSleep).
let sleepControl: SleepControl | null = null;
// Served beside the dispatcher on every connection, once the engine is up.
let extensions: RpcExtension[] = [];
// Where the network port listens (`<host>:<port>`), reported in hello for other
// boxes to link to (cross-box), or null with no listener.
let wsAddr: string | null = null;
// The provider this box runs on and its name there, reported in hello so a client
// that added the box by its address can wake it, or at least name where it runs.
// Undefined until detection has answered, then null on a box no known provider runs.
let boxProvider: BoxWake | null | undefined;
// Whether that provider can put the box to sleep (it has a sleep driver). One that
// can't (exe.dev) is always on, whatever idleSleepMinutes says.
let boxCanSleep = false;
// The lock on the network port (pairing.ts): which devices may use the box over
// the WebSocket. The unix socket (what `attach` relays over SSH) is never gated.
const pairing: PairingGuard = {
	store: new Pairings(DATA_DIR),
	live: new LiveConnections(),
	limiter: new RedeemLimiter(),
	fromLinks: new LinkLimiter(),
};

// A box with no database yet is a fresh install, which can come up locked to
// paired devices (pairing.ts). One that has run before keeps whatever it had:
// open until someone locks it, so an upgrade never locks a phone out.
// shortcut: fresh boxes start open too. Ateam Go on the App Store (1.3.x) can't
// pair, so a locked box would shut that phone out. Turn this on once an Ateam Go
// that pairs is live on the App Store.
const LOCK_NEW_BOXES = false;

function isFreshBox(): boolean {
	return !existsSync(join(DATA_DIR, "ateam.sqlite")) && !existsSync(join(DATA_DIR, "grove.sqlite"));
}

async function runDaemon(): Promise<void> {
	// Single-instance guard: if a daemon already serves SOCK, bow out — do NOT
	// steal it. The old code blindly unlink()'d the socket then listen()'d, on the
	// false premise that a live daemon would trip EADDRINUSE; but unlinking the file
	// is exactly what defeats that guard, so a second `ateam daemon` silently
	// supplanted the first — orphaning its engine, live PTY sessions, and SQLite
	// writer. Probe by connecting first: only a live listener should stop us.
	if (await isDaemonLive(SOCK)) {
		console.log(`[ateam] a daemon is already listening at ${SOCK}; nothing to do`);
		return;
	}

	// The PTY daemon bundle (node-pty + xterm). Shipped beside the ateam bin on
	// the server; overridable for dev.
	const ptyDaemon = process.env.ATEAM_PTY_DAEMON ?? join(dirname(SELF), "daemon.js");

	const fresh = isFreshBox();
	// A new box starts always on, unless its file already says otherwise: billed while
	// up, but nothing needs a key to wake it. A box that ran before keeps sleeping as
	// it did until someone chooses (the phone's box form, the desktop's box page).
	if (fresh && !hasBoxChoice()) updateSettings({ box: { alwaysOn: true } });
	// The boxes this one links to (links.ts): its agents and its Lead reach them.
	const links = new BoxLinks({ dataDir: DATA_DIR, log: (line) => console.log(line) });
	const engine = await createEngine({
		dataDir: DATA_DIR,
		daemonPath: ptyDaemon,
		execPath: process.execPath,
		peerRelay: links,
	});
	if (LOCK_NEW_BOXES && fresh && pairing.store.lockIfNew())
		console.log("[ateam] new box: locked to paired devices (pair one with `ateam pair`)");
	engine.startLoops();
	const dispatcher = createDispatcher(engine);
	// What this box's Lead reaches: this box, then the boxes it links to, through
	// the router the desktop and the phone use for several engines (aggregate.ts).
	const here: AggregateBackend = {
		kind: "local",
		handle: (method, args) => dispatcher.handle(method, args),
	};
	const reachable: AggregateBackend[] = [here, ...links.backends];
	links.onChange(() => reachable.splice(1, reachable.length - 1, ...links.backends));
	const reach = createAggregate(reachable, here);
	// This box's own Lead chat, for the phone (lead/engine-lead.ts). Only here:
	// the desktop's in-process engine has the desktop's Lead instead.
	const lead = engineLead({
		engine,
		dispatcher,
		dir: join(DATA_DIR, "lead"),
		log: (line) => console.log(line),
		reach: {
			handle: async (method, args) => {
				// A task on a linked box: the Lead's message goes as this box's Lead,
				// weighed there as a colleague's request, and an answer to its agent's
				// question isn't passed on: a link never speaks, or approves, as the user.
				if (method === CH.peersSendFromLead || method === CH.tasksAnswerQuestion) {
					const req = (args[0] ?? {}) as { taskId?: unknown; body?: unknown };
					const at = typeof req.taskId === "string" ? reach.ownerOf.get(req.taskId) : undefined;
					if (at && at !== here) {
						if (method === CH.tasksAnswerQuestion)
							throw new Error(
								`That task is on ${links.nameOf(at)}: the user answers it from their Mac or phone, which reach every box. A link between boxes can't answer for them.`,
							);
						return links.asLead(at, req.taskId as string, String(req.body ?? ""));
					}
				}
				return reach.handle(method, args);
			},
			machineOf: (id) => links.nameOf(reach.ownerOf.get(id)),
			onTaskUpdated: (cb) =>
				links.onTaskUpdated((task, backend) => {
					reach.learn(backend, task);
					cb(task);
				}),
		},
	});
	// links:list and links:set, for the Mac that sets the links up. Nothing pushed.
	const linkMethods: RpcExtension = {
		methods: [CH.linksList, CH.linksSet],
		handle: async (method, args) => (method === CH.linksSet ? links.set(args[0]) : links.status()),
		subscribe: () => () => {},
	};
	extensions = [lead, linkMethods];
	links.start();
	wsAddr = resolveWsAddr(process.env, DATA_DIR) ?? null;
	// A box listening on 127.0.0.1 behind Tailscale Serve (boxd) is reached at the
	// tailnet address Serve forwards: hello reports that one, so boxes can link to it.
	void reachableWsAddr(wsAddr).then((addr) => {
		wsAddr = addr;
	});

	const dir = dirname(SOCK);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	// The probe found no live daemon, so any socket file here is stale (a crashed
	// daemon leaves the file behind) — remove it so listen() can bind.
	try {
		if (existsSync(SOCK)) unlinkSync(SOCK);
	} catch {
		/* best-effort */
	}

	// allowHalfOpen: a one-shot client that sends a request then closes its write
	// side (EOF) must still receive the reply — without this the socket's read-end
	// 'end' auto-closes the write-end, dropping the response mid-flight.
	const server = createServer({ allowHalfOpen: true }, (sock: Socket) => {
		// Each client gets its own serveRpc over one connection; the engine (and
		// its PTY sessions) is shared and outlives any single client. Trusted: only
		// this user's processes can open the socket, and SSH authenticated the relay.
		serveClient(engine, dispatcher, socketServerTransport(sock), true);
	});
	server.on("error", (err: NodeJS.ErrnoException) => {
		// Lost a startup race: another daemon bound SOCK between our probe and
		// listen(). If it's live, bow out cleanly instead of dying with an error.
		if (err.code === "EADDRINUSE") {
			void isDaemonLive(SOCK).then((live) => {
				if (live) {
					console.log(`[ateam] another daemon won the socket; exiting`);
					process.exit(0);
				}
				console.error(`[ateam] ${SOCK} is busy but no daemon answers`);
				process.exit(1);
			});
			return;
		}
		console.error(`[ateam] daemon error: ${err.message}`);
		process.exit(1);
	});
	server.listen(SOCK, () => {
		console.log(`[ateam] daemon listening at ${SOCK}`);
		// Connect the PTY daemon in the BACKGROUND, and only once we own the socket:
		// don't block RPC on it (git/tasks/board serves immediately; agent spawning
		// reconnects lazily), and a daemon that bowed out never spawns a stray PTY
		// daemon. Awaiting here previously stalled a fresh box's first attach.
		void engine.connectPty().catch((err) => {
			console.error(`[ateam] PTY daemon connect failed: ${(err as Error).message}`);
		});
	});

	maybeStartWsListener(engine, dispatcher);
	void maybeStartIdleSleep(engine, lead);
}

/**
 * Serve one client, on either transport. Attaching to a released box holds it
 * (sleep/control.ts): an idle connection is not traffic a provider sees, so a
 * box a client just woke would otherwise fall asleep under it. Every transport
 * goes through here, so none can forget that.
 */
function serveClient(
	engine: Engine,
	dispatcher: Dispatcher,
	transport: Parameters<typeof serveRpc>[2],
	trusted: boolean,
): void {
	sleepControl?.touch();
	serveRpc(engine, dispatcher, transport, extensions, {
		trusted,
		pairing,
		wsAddr,
		provider: providerReport(
			boxProvider,
			boxCanSleep ? idleSleepMinutesOf(readSettings().settings) : 0,
		),
	});
}

/**
 * On a provider that can put this box to sleep (see sleep/index.ts), let it sleep
 * once nobody has used it for `idleSleepMinutes` (an agent working, typing in a
 * terminal, the Lead chat), and wake it for loop ticks and pending waits.
 * Anywhere else no driver answers and this does nothing.
 */
async function maybeStartIdleSleep(
	engine: Engine,
	lead: ReturnType<typeof engineLead>,
): Promise<void> {
	const log = (line: string) => console.log(line);
	const driver = await detectSleepDriver({
		log,
		// Set at the provider by the user (boxd: hibernation off, after Ateam had let
		// it sleep): kept as this box's own choice, so Ateam stops putting it to sleep.
		onAlwaysOn: () => {
			updateSettings({ box: { alwaysOn: true } });
		},
	});
	boxProvider = driver?.provider ?? alwaysOnProvider();
	boxCanSleep = driver !== null;
	if (!driver) return;
	log(`[ateam] on ${driver.where}: letting it sleep when idle`);
	sleepControl = await startSleepControl(driver, {
		working: () => engine.isWorking(),
		setupActive: () => dotfilesFor(engine.services.userDataDir).active(),
		lastInputAt: () => engine.lastInputAt(),
		lead: () => lead.activity(),
		nextLoopAt: () => {
			// A pending wait wakes the box too, and pausing loops does not hold it:
			// it is a reminder the user asked for, not a scheduled job. Only where the
			// provider can wake us, though: a wait days out must not hold a box awake
			// for days, and the clients notify on the date by themselves anyway.
			const nextWait = driver.canWakeForLoops ? engine.services.waits.nextDueAt() : null;
			const nextLoop = (): number | null => {
				if (readSettings().settings.engine.loopsPaused) return null;
				const live = engine.services.loopRunner.describe().filter((l) => l.enabled);
				if (live.length === 0) return null;
				// A live loop with no slot yet is about to be scheduled: treat it as due now.
				if (live.some((l) => l.nextRunAt == null)) return Date.now();
				return Math.min(...live.map((l) => l.nextRunAt as number));
			};
			const due = [nextLoop(), nextWait].filter((t): t is number => t != null);
			return due.length > 0 ? Math.min(...due) : null;
		},
		idleMinutes: () => idleSleepMinutesOf(readSettings().settings),
		log,
	});
}

/**
 * Opt-in WebSocket listener, for network clients that can't run `ateam attach`
 * over SSH — the phone over Tailscale (React Native has no child `ssh`, but ships
 * a WebSocket). OFF by default: the box stays listener-free and the desktop's
 * SSH-only path is unchanged unless ATEAM_WS_ADDR, or the installer's
 * <data dir>/ws-addr (src/ws-addr.ts), names an address.
 *
 * This socket carries NO auth of its own — auth is the network's job (a Tailscale
 * ACL / a private interface), exactly as the unix socket trusts filesystem perms.
 * So we REFUSE a wildcard bind: exposing an unauthenticated engine on 0.0.0.0
 * would hand it to the whole network. Bind to an explicit private address (the
 * Tailscale IP) only. Same guard the reverted TCP listener used.
 */
function maybeStartWsListener(engine: Engine, dispatcher: Dispatcher): void {
	const addr = resolveWsAddr(process.env, DATA_DIR);
	if (!addr) return;
	const lastColon = addr.lastIndexOf(":");
	const host = lastColon > 0 ? addr.slice(0, lastColon) : "";
	const port = Number(addr.slice(lastColon + 1));
	if (!host || host === "0.0.0.0" || host === "::" || !Number.isInteger(port) || port <= 0) {
		console.error(
			`[ateam] refusing WS listen on "${addr}": ATEAM_WS_ADDR (or ${join(DATA_DIR, WS_ADDR_FILE)}) ` +
				"must be <host>:<port> where host is an explicit private address (e.g. the Tailscale IP), " +
				"never a wildcard (0.0.0.0/::)",
		);
		process.exit(1);
	}
	startWsListener({
		host,
		port,
		// Each client gets its own serveRpc; the engine (and its PTY sessions) is
		// shared and outlives any single client — same contract as the socket path.
		onConnection: (sock) => serveClient(engine, dispatcher, wsServerTransport(sock), false),
		log: (line) => console.log(line),
	});
}

/**
 * Is a daemon already listening on `sock`? Connect-probe: a successful connect
 * means a live listener owns it; ECONNREFUSED means a stale socket file (crashed
 * daemon, no listener); ENOENT means no file at all. Only a live listener should
 * stop a new daemon from starting.
 */
function isDaemonLive(sock: string): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = connect(sock);
		probe.once("connect", () => {
			probe.destroy();
			resolve(true);
		});
		probe.once("error", () => {
			probe.destroy();
			resolve(false);
		});
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
					const sockDir = dirname(SOCK);
					if (!existsSync(sockDir)) mkdirSync(sockDir, { recursive: true });
					const log = openSync(join(sockDir, "daemon.log"), "a");
					// Say so, on STDERR — stdout is the RPC wire (piped above). A daemon
					// started here owns DATA_DIR, and on a desktop machine that is NOT
					// where the app keeps its database (Electron uses its own userData
					// dir), so starting one silently would serve an empty board from a
					// second engine with no hint that it had happened.
					console.error(`[ateam] no daemon at ${SOCK}; starting one (data dir ${DATA_DIR})`);
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
} else if (cmd === "pair") {
	runPair(process.argv.slice(3));
} else {
	console.error(
		"usage: ateam <daemon | attach --stdio | pair [--unlock | --add-device <hash> [--label <name>]]>",
	);
	process.exit(2);
}

/**
 * `ateam pair`: a one-time code for a device to pair with this locked box, from its
 * own terminal, the way in when no paired device is at hand (the phone locked it and
 * the Mac reaches it only over Tailscale, or the one paired phone is lost). `--unlock`
 * opens a locked box again, for when no paired device is left. `--add-device <hash>`
 * pairs the phone that created this box (Ateam Go's Create a box), by the sha256 of
 * a token only the phone holds. All act on the same file the daemon reads (pairing.ts).
 */
function runPair(args: string[]): void {
	const at = args.indexOf("--add-device");
	if (at >= 0) {
		// The installer runs this before the engine first starts (ATEAM_PAIR_DEVICE),
		// so a fresh box gets here what the engine's first start would have given it.
		if (LOCK_NEW_BOXES && isFreshBox()) pairing.store.lockIfNew();
		const l = args.indexOf("--label");
		const label = l >= 0 ? args[l + 1] : undefined;
		try {
			const added = pairing.store.addDevice(args[at + 1] ?? "", label, "phone");
			console.log(added ? `Paired ${label ?? "the device"}.` : "That device is paired already.");
		} catch (err) {
			console.error(err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		}
		return;
	}
	if (args.includes("--unlock")) {
		pairing.store.unlock();
		console.log("This box is open again: any device that can reach its port may use it.");
		console.log("Lock it from Settings → Boxes in Ateam once a device is connected.");
		return;
	}
	// An open box lets any device in, so a code would unlock nothing, and neither app
	// asks for one there. Locking happens from a device, which is paired as it locks.
	if (!pairing.store.locked()) {
		console.log(
			"This box is open: any device that can reach its port may use it, so there's nothing to pair.",
		);
		console.log(
			"Lock it from Ateam first: Settings → Boxes → Access on a Mac, or Lock it on its card in Ateam Go.",
		);
		process.exitCode = 1;
		return;
	}
	const { code, expiresAt } = pairing.store.invite();
	const minutes = Math.round((expiresAt - Date.now()) / 60000);
	console.log(`Pairing code: ${code.slice(0, 4)}-${code.slice(4)}`);
	console.log(`Enter it in Ateam within ${minutes} minutes. It works once.`);
}
