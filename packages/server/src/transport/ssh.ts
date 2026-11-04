// Client-side SSH transport: spawn `ssh <host> <remote command…>` and speak the
// RPC protocol over the child's stdio. The remote command is `ateam attach
// --stdio` (which relays to the daemon); its stdout/stdin carry newline-JSON
// frames, stderr is inherited so ssh/auth errors surface. This is the transport
// a desktop/mobile client wraps in createRpcClient to drive a remote engine.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import type { ClientTransport } from "@ateam/protocol";
import { streamClientTransport } from "./stream";

export interface SshClient {
	transport: ClientTransport;
	child: ChildProcess;
	/** Kill the ssh child (ends the relay; the remote daemon and its sessions live on). */
	close(): void;
	/** The last few KB ssh wrote to stderr, once it has exited (waiting at most `ms`
	 *  for that): where its reason for refusing a connection is, for describeSshFailure. */
	stderr(ms?: number): Promise<string>;
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
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (!child.stdout || !child.stdin) {
		throw new Error("ssh child is missing stdio pipes");
	}
	// Passed on to this process's stderr as before, and its tail kept: a reconnect ssh
	// refuses (a rebuilt box's new host key, say) has no other way to say why.
	let said = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		process.stderr.write(chunk);
		said = (said + chunk.toString("utf8")).slice(-4096);
	});
	const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
	const transport = streamClientTransport(child.stdout, child.stdin);
	return {
		transport,
		child,
		close: () => child.kill(),
		stderr: async (ms = 1_000) => {
			await Promise.race([exited, new Promise((r) => setTimeout(r, ms))]);
			return said;
		},
	};
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

// What ssh does with a host key it has never seen is StrictHostKeyChecking. Its
// default, "ask", needs a terminal, and sshExec has none (batch mode, stdin
// closed), so a first contact fails with "Host key verification failed".
const ACCEPT_NEW = ["-o", "StrictHostKeyChecking=accept-new"];

/** `ssh -G <dest>`: the options ssh would use for `dest`, one per line; "" when ssh can't say. */
function sshConfigOf(dest: string): Promise<string> {
	return new Promise((resolve) => {
		execFile("ssh", ["-G", "--", dest], { timeout: 5_000 }, (err, stdout) =>
			resolve(err ? "" : stdout),
		);
	});
}

/**
 * Flags for a first contact the user asked for, such as setting a box up.
 * accept-new trusts a host key ssh has never seen, which is what typing "yes" at
 * the prompt does, and still refuses one that has changed. A `-o` on the command
 * line overrides the user's ssh config, so this applies only while ssh would ask
 * (its default, as `ssh -G` reports it): a value the user chose, such as `yes`,
 * is left alone.
 */
export async function firstContactFlags(
	dest: string,
	readConfig: (dest: string) => Promise<string> = sshConfigOf,
): Promise<string[]> {
	return /^stricthostkeychecking ask$/m.test(await readConfig(dest)) ? [...ACCEPT_NEW] : [];
}

/**
 * ssh's own reason for failing (exit 255), in words, read from what sshExec
 * streamed: ssh writes it to stderr next to the remote command's output. Null
 * when no reason is in there, so the caller keeps its generic message. The
 * patterns are OpenSSH's messages, as test/ssh-first-contact.test.ts records them.
 */
export function describeSshFailure(output: string): string | null {
	// Checked before the unknown-key case: ssh ends this one with the same last line.
	if (output.includes("REMOTE HOST IDENTIFICATION HAS CHANGED")) {
		// ssh names the known_hosts line holding the old key; a reconnect has no log to show.
		const old = output.match(/Offending \S+ key in (\S+):(\d+)/);
		const where = old
			? `line ${old[2]} of ${old[1]}`
			: "~/.ssh/known_hosts (the log names the line)";
		return `The box's host key has changed since this Mac last connected, so ssh refused it. If the box was rebuilt, remove its old key from ${where}, then try again.`;
	}
	// StrictHostKeyChecking yes in the user's ssh config: ssh never adds a new key,
	// so a terminal would refuse this box too, and the key has to be added by hand.
	if (/No \S+ host key is known for/.test(output)) {
		return "Your ssh config only connects to hosts already in known_hosts (StrictHostKeyChecking yes), so ssh refused this new box. Add its key there yourself, then try again.";
	}
	if (output.includes("Host key verification failed")) {
		return "ssh doesn't know this box's host key and wasn't allowed to accept a new one. Connect once from a terminal to check and accept it, then try again.";
	}
	if (/Permission denied \([\w,-]+\)/.test(output)) {
		return "The box didn't accept a key ssh could use without asking. A key with a passphrase only works here once it's loaded into ssh-agent, and a provider may need a key of its own, named by an IdentityFile in ~/.ssh/config.";
	}
	if (output.includes("ssh: Could not resolve hostname")) {
		return "ssh couldn't find a box by that name. Check the spelling, or that it matches a Host in ~/.ssh/config.";
	}
	if (
		/ssh: connect to host .+: (Connection refused|Operation timed out|Connection timed out)/.test(
			output,
		)
	) {
		return "Nothing answered on the box's SSH port. Check that the box is running and the address is right.";
	}
	return null;
}

/**
 * Why install.sh stopped, in its own words: the last line it died with (`!! …`, its
 * die()), read from what sshExec streamed. Null when it said nothing that way, such
 * as when ssh itself failed.
 */
export function installerFailure(output: string): string | null {
	const lines = output.split(/\r?\n/).filter((l) => l.startsWith("!! "));
	return lines.length > 0 ? (lines[lines.length - 1] ?? "").slice(3).trim() || null : null;
}
