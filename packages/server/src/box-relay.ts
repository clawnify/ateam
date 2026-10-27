// How a box's in-app services (the editor, the browser view) reach clients that
// dial the box over its tailnet instead of SSH.
//
// Every such service binds loopback, because that is the one address the
// desktop's ssh forward can always reach: the forward is opened at connect time,
// before the box is asked anything, so it can only name 127.0.0.1. A box that also
// serves clients over its tailnet (ATEAM_WS_ADDR, or the installer's ws-addr) gets
// a relay on <tailnet-ip>:<port> into the loopback port, so those clients reach
// the same service directly. code-server and websockify each take one bind
// address, so a second bind isn't theirs to offer.
//
// Best-effort: a relay that can't bind (Tailscale in userspace mode owns no
// interface, or the port is taken) costs the tailnet clients alone, never the
// service or its ssh path.
import { createConnection, createServer, type Server } from "node:net";
import { resolveWsAddr } from "./ws-addr";

/** The tailnet host this box serves clients on, or null when it serves none. */
export function relayHost(env: NodeJS.ProcessEnv, dataDir: string): string | null {
	const addr = resolveWsAddr(env, dataDir);
	if (!addr) return null;
	const host = addr.replace(/:\d+$/, "");
	if (!host || host === "127.0.0.1" || host === "localhost") return null;
	return host;
}

const relays = new Map<string, Server>();

/**
 * Relay host:port into 127.0.0.1:port, once per engine. Resolves either way; a
 * failed bind is logged and retried on the next call.
 */
export function ensureRelay(
	host: string,
	port: number,
	log: (line: string) => void,
): Promise<void> {
	const key = `${host}:${port}`;
	if (relays.has(key)) return Promise.resolve();
	const server = createServer((client) => {
		const upstream = createConnection({ host: "127.0.0.1", port });
		client.pipe(upstream).pipe(client);
		client.on("error", () => upstream.destroy());
		upstream.on("error", () => client.destroy());
	});
	relays.set(key, server);
	return new Promise((resolve) => {
		server.once("listening", () => resolve());
		server.once("error", (err: Error) => {
			relays.delete(key);
			log(`[ateam] no tailnet relay on ${key} (${err.message}); ssh clients are unaffected`);
			resolve();
		});
		server.listen(port, host);
	});
}
