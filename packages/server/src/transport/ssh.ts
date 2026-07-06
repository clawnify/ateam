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
	const child = spawn("ssh", [...(opts.sshFlags ?? []), host, ...remoteArgs], {
		stdio: ["pipe", "pipe", "inherit"],
	});
	if (!child.stdout || !child.stdin) {
		throw new Error("ssh child is missing stdio pipes");
	}
	const transport = streamClientTransport(child.stdout, child.stdin);
	return { transport, child, close: () => child.kill() };
}
