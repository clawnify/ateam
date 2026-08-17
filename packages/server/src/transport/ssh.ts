// Client-side SSH transport: spawn `ssh <host> <remote command…>` and speak the
// RPC protocol over the child's stdio. The remote command is `ateam attach
// --stdio` (which relays to the daemon); its stdout/stdin carry newline-JSON
// frames, stderr is inherited so ssh/auth errors surface. This is the transport
// a desktop/mobile client wraps in createRpcClient to drive a remote engine.
import { type ChildProcess, spawn } from "node:child_process";
import type { ClientTransport } from "@ateam/protocol";
import { streamClientTransport } from "./stream";

export interface SshClient {
	transport: ClientTransport;
	child: ChildProcess;
	/** Kill the ssh child (ends the relay; the remote daemon and its sessions live on). */
	close(): void;
}

export interface SshOptions {
	/** Extra `ssh` flags placed before the host (e.g. ["-i", keyPath, "-o", "BatchMode=yes"]). */
	sshFlags?: string[];
}

// OpenSSH's own liveness check, in place of a second app-level probe. ServerAliveInterval
// defaults to 0 — OFF (ssh_config(5)) — so a black-holed connection (laptop sleep, a
// Tailscale flap, the box wedged) leaves the ssh child ALIVE with nothing coming back, and
// every RPC through it pending forever. These are sent through the encrypted channel and
// answered by sshd itself, so a silent long-running command (an installer, a big clone) is
// never mistaken for a dead peer. 15 × 3 ≈ 45s to a real exit — which closes the pipe, and
// a closed pipe is what makes the client drop the box (apps/desktop/src/main/host.ts).
const KEEPALIVE = ["-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];

/**
 * Open an RPC transport to `host` by running `remoteArgs` over SSH. `host` is an
 * ssh destination (`user@host`, or an ssh_config alias — ProxyJump/keys/known_hosts
 * are OpenSSH's job, not ours).
 */
export function sshClientTransport(
	host: string,
	remoteArgs: string[],
	opts: SshOptions = {},
): SshClient {
	const child = spawn("ssh", [...KEEPALIVE, ...(opts.sshFlags ?? []), host, ...remoteArgs], {
		stdio: ["pipe", "pipe", "inherit"],
	});
	if (!child.stdout || !child.stdin) {
		throw new Error("ssh child is missing stdio pipes");
	}
	const transport = streamClientTransport(child.stdout, child.stdin);
	return { transport, child, close: () => child.kill() };
}

export interface SshExecResult {
	/** Remote command exit code; null if the ssh child was killed by a signal. */
	code: number | null;
}

export interface SshExecOptions extends SshOptions {
	/** Called with each stdout/stderr chunk as UTF-8 text, in arrival order. */
	onData?: (chunk: string) => void;
}

/**
 * Run a one-shot `command` on `host` over SSH and stream its combined
 * stdout+stderr, resolving with the remote exit code. Unlike sshClientTransport
 * (a persistent RPC relay), this is for provisioning-style commands whose OUTPUT
 * is the point — piping an installer to the box and showing its progress.
 *
 * `command` is passed as a single ssh argument (ssh space-joins remote args, so a
 * `bash -lc '…'` must arrive whole). BatchMode=yes fails fast on a missing key
 * rather than hanging on a prompt the desktop can't answer (stdin is closed) —
 * these boxes authenticate with the user's ssh-agent/keys, same as `attach`.
 */
export function sshExec(
	host: string,
	command: string,
	opts: SshExecOptions = {},
): Promise<SshExecResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"ssh",
			["-o", "BatchMode=yes", ...KEEPALIVE, ...(opts.sshFlags ?? []), host, command],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		const emit = (b: Buffer) => opts.onData?.(b.toString("utf8"));
		child.stdout?.on("data", emit);
		child.stderr?.on("data", emit);
		child.on("error", reject);
		child.on("close", (code) => resolve({ code }));
	});
}
