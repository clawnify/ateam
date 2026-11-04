// A box on Tailscale in userspace mode (every boxd machine) has no interface of its
// own carrying its tailnet address, so it can't open a plain connection to another
// tailnet machine: the packets go nowhere. `tailscale nc` reaches it through
// tailscaled itself, as the box's own user (checked on boxd, Tailscale 1.102.2).
// Links to other boxes (links.ts) go that way there. Its listener, on 127.0.0.1
// behind Tailscale Serve, is reached at the tailnet address Serve forwards
// (reachableWsAddr).

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { Duplex } from "node:stream";

const CGNAT = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;
const TAILNET_V6 = /^fd7a:115c:a1e0:/i;

/** A tailnet address or name: 100.64.0.0/10, fd7a:115c:a1e0::/48, or *.ts.net. */
export function isTailnetHost(host: string): boolean {
	const h = host.replace(/^\[|\]$/g, "").replace(/\.$/, "");
	return CGNAT.test(h) || TAILNET_V6.test(h) || /\.ts\.net$/i.test(h);
}

/** Whether an interface of this machine carries a tailnet address: Tailscale in
 *  its usual mode does; in userspace mode nothing does. */
export function hasTailnetInterface(
	ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): boolean {
	return Object.values(ifaces).some((list) =>
		(list ?? []).some((a) => isTailnetHost(a.address)),
	);
}

/** Whether a connection to `host` has to go through `tailscale nc` from here. */
export function needsTailscaleNc(
	host: string,
	ifaces?: ReturnType<typeof networkInterfaces>,
): boolean {
	return isTailnetHost(host) && !hasTailnetInterface(ifaces);
}

/** A connection to host:port through `tailscale nc`, as a stream a WebSocket can
 *  run over. Closing either side ends the other. */
export function tailscaleNc(
	host: string,
	port: number,
	spawnNc: (args: string[]) => ChildProcess = (args) =>
		spawn("tailscale", args, { stdio: ["pipe", "pipe", "ignore"] }),
): Duplex {
	const child = spawnNc(["nc", host.replace(/^\[|\]$/g, ""), String(port)]);
	if (!child.stdin || !child.stdout) throw new Error("tailscale nc started without pipes");
	const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
	const end = (err?: Error) => {
		if (!stream.destroyed) stream.destroy(err);
	};
	child.on("error", (e) => end(new Error(`tailscale nc: ${e.message}`)));
	child.on("exit", () => end());
	stream.on("close", () => {
		if (child.exitCode === null) child.kill();
	});
	return stream;
}

/** Run the tailscale CLI and give back what it printed, or null when it fails. */
export function runTailscale(args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile("tailscale", args, { timeout: 3_000 }, (err, stdout) =>
			resolve(err ? null : stdout),
		);
	});
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Where other machines reach this box's network port: the address it listens on,
 * or, when that serves this machine alone (127.0.0.1, as on boxd), the tailnet
 * address and port Tailscale Serve forwards to it. Null without a listener.
 */
export async function reachableWsAddr(
	addr: string | null,
	run: (args: string[]) => Promise<string | null> = runTailscale,
): Promise<string | null> {
	if (!addr) return null;
	const at = addr.lastIndexOf(":");
	const host = addr.slice(0, at).replace(/^\[|\]$/g, "");
	const port = addr.slice(at + 1);
	if (at <= 0 || !LOOPBACK.has(host)) return addr;
	let serve: { TCP?: Record<string, { TCPForward?: string }> } | null = null;
	try {
		serve = JSON.parse((await run(["serve", "status", "--json"])) ?? "null");
	} catch {
		serve = null;
	}
	const forwarded = Object.entries(serve?.TCP ?? {}).find(([, h]) =>
		[`localhost:${port}`, `127.0.0.1:${port}`].includes(h.TCPForward ?? ""),
	);
	if (!forwarded) return addr;
	const ip = ((await run(["ip", "-4"])) ?? "").trim().split("\n")[0]?.trim();
	return ip && isTailnetHost(ip) ? `${ip}:${forwarded[0]}` : addr;
}
