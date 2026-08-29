// The engine's embedded editor: one code-server process per engine, started on
// demand, serving every task worktree via VS Code web's ?folder= URL. The engine
// only knows how to RUN it on its own machine; how a client reaches the port
// (ssh forward, tailnet, localhost) is the client's transport knowledge.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	DEFAULT_EDITOR_PORT,
	type EditorEndpointDTO,
	type EditorOpenResult,
} from "@ateam/protocol";

/** Where the standalone install puts the binary (plus the usual system dirs). */
const BIN_CANDIDATES = [
	join(homedir(), ".local", "bin", "code-server"),
	"/usr/local/bin/code-server",
	"/opt/homebrew/bin/code-server",
];

/** The build the Editor tab was tested against; installs are pinned to it so a
 *  fleet of boxes doesn't drift. Bumped deliberately, with an Ateam release. */
export const CODE_SERVER_VERSION = "4.135.0";

/** The official standalone installer: user-space, no root, ~/.local prefix. */
export const INSTALL_CMD =
	"curl -fsSL https://code-server.dev/install.sh | " +
	`sh -s -- --method=standalone --prefix=$HOME/.local --version ${CODE_SERVER_VERSION}`;

/**
 * Run the installer on THIS machine. Consent lives with the caller — engines
 * only ever run this after a client relayed the user's yes.
 */
export function installCodeServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile("sh", ["-c", INSTALL_CMD], { timeout: 10 * 60_000 }, (err, _out, stderr) => {
			if (!err && findCodeServer(env)) return resolve();
			const tail = (stderr ?? "").trim().split("\n").slice(-3).join(" ");
			reject(new Error(`code-server install failed${tail ? `: ${tail}` : ""}`));
		});
	});
}

/** Absolute path of the code-server binary, or null. `env` injectable for tests. */
export function findCodeServer(env: NodeJS.ProcessEnv = process.env): string | null {
	const candidates = [
		...(env.ATEAM_CODE_SERVER_BIN ? [env.ATEAM_CODE_SERVER_BIN] : []),
		...BIN_CANDIDATES,
		...(env.PATH?.split(":") ?? []).filter(Boolean).map((d) => join(d, "code-server")),
	];
	for (const bin of candidates) {
		try {
			accessSync(bin, constants.X_OK);
			return bin;
		} catch {
			/* keep looking */
		}
	}
	return null;
}

/**
 * The interface the editor binds. Mirrors how the daemon itself is exposed: with
 * ATEAM_WS_ADDR set the box serves clients over the tailnet, so the editor binds
 * the same address (same trust boundary); otherwise loopback only, reached over
 * the client's ssh forward.
 */
export function editorBindHost(env: NodeJS.ProcessEnv = process.env): string {
	const ws = env.ATEAM_WS_ADDR;
	if (!ws) return "127.0.0.1";
	const host = ws.replace(/:\d+$/, "");
	return host.length > 0 ? host : "127.0.0.1";
}

/**
 * Seed code-server's user settings ONCE, before its first run: Ateam-dark theme
 * and workspace trust off (every task is a new worktree — a per-folder trust
 * prompt would fire on each one). Never touches an existing settings file: after
 * first run the file is the user's.
 */
export function preseedUserSettings(dataDir = join(homedir(), ".local", "share", "code-server")) {
	const file = join(dataDir, "User", "settings.json");
	if (existsSync(file)) return;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		`${JSON.stringify(
			{
				"workbench.colorTheme": "Default Dark Modern",
				"security.workspace.trust.enabled": false,
			},
			null,
			2,
		)}\n`,
	);
}

export interface EditorHost {
	/** Start (or reuse) the editor; `needsInstall` when the binary is absent. */
	ensure(): Promise<EditorOpenResult>;
}

export function createEditorHost(env: NodeJS.ProcessEnv = process.env): EditorHost {
	const port = Number(env.ATEAM_EDITOR_PORT) || DEFAULT_EDITOR_PORT;
	let child: ChildProcess | null = null;
	let starting: Promise<EditorOpenResult> | null = null;

	async function waitReady(host: string): Promise<void> {
		// code-server exposes /healthz without auth; poll until it answers.
		for (let i = 0; i < 60; i++) {
			try {
				const res = await fetch(`http://${host}:${port}/healthz`, {
					signal: AbortSignal.timeout(1000),
				});
				if (res.ok) return;
			} catch {
				/* not up yet */
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		throw new Error(`The editor didn't answer on port ${port} within 15s.`);
	}

	function start(bin: string): Promise<EditorEndpointDTO> {
		const host = editorBindHost(env);
		preseedUserSettings();
		const proc = spawn(
			bin,
			["--bind-addr", `${host}:${port}`, "--auth", "none", "--disable-telemetry"],
			{ stdio: "ignore" },
		);
		child = proc;
		proc.on("exit", () => {
			if (child === proc) child = null;
		});
		// Tie the editor to the engine's life — an orphaned code-server would keep
		// the port and make the next engine's spawn fail silently.
		process.on("exit", () => proc.kill());
		return waitReady(host).then(() => ({ port }));
	}

	return {
		ensure() {
			// Alive child answering = reuse; a died child (crash, external kill)
			// falls through to a fresh start.
			if (child && child.exitCode === null) return Promise.resolve({ port });
			const bin = findCodeServer(env);
			if (!bin) return Promise.resolve({ needsInstall: true });
			if (!starting) {
				starting = start(bin).finally(() => {
					starting = null;
				});
			}
			return starting;
		},
	};
}
