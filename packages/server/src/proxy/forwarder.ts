// The box's proxy forwarder: a plain HTTP proxy on loopback that sends traffic
// on through the user's proxy, adding its username and password. Chrome can't
// carry proxy credentials (its --proxy-server flag and policy take none, and a
// proxy's 407 opens a sign-in dialog nobody answers on a box), and many tools
// can't speak SOCKS; this speaks plain HTTP to all of them.
//
// Two ports, one per switch: Chrome's managed policy points at the browser port,
// HTTP(S)_PROXY at the server port. Each port goes through the proxy while its
// switch is on, and straight out while it is off: agents started while Server
// was on still have HTTPS_PROXY set, and turning Server off then takes them
// direct at once instead of leaving them with no network.
//
// With a switch on, a proxy that fails fails the request (a 502). Nothing falls
// back to the box's own address. `proxy.json` is read for every new connection,
// so a saved change applies at once, and tunnels opened on the old route are
// closed when the route changes.
//
// Raw sockets, not node:http: a request line is read here and the rest is
// relayed byte for byte, so one request runs per connection (`Connection:
// close` onwards). Node's http client won't resume a socket handed to it
// already paused, and Bun's ignores `createConnection`; plain sockets behave
// the same under both.
//
// It runs on its own (`ateam proxy`, started by the engine), so an engine
// restart or update doesn't cut the browser or the agents off. It listens on
// loopback only, so it serves this box's own processes, the same reach as the
// TaskWindow and CDP ports beside it.
import { watchFile } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { type ProxyUpstream, parseProxyUrl } from "@ateam/protocol";
import {
	DEFAULT_PROXY_PORTS,
	FORWARDER_HEALTH_PATH,
	FORWARDER_VERSION,
	type ProxyPorts,
	proxyConfigPath,
	readProxyConfig,
} from "./config";
import {
	basicAuth,
	dialDirect,
	dialProxy,
	HandshakeReader,
	openTunnel,
	ProxyError,
	refusal,
} from "./tunnel";

type Kind = "browser" | "server";
/** Where a port's traffic goes now. `key` tells routes apart without holding the password. */
type Route = { key: string; up: ProxyUpstream | null; error?: string };

export interface ForwarderOptions {
	configPath: string;
	timeoutMs?: number;
	log?: (line: string) => void;
}

export interface Forwarder {
	listen(kind: Kind, port: number, host?: string): Promise<Server>;
	/** Re-read the file: close the tunnels a changed route no longer covers. */
	refresh(): void;
	close(): Promise<void>;
}

/** Headers about this hop, which the next one must not get. */
const HOP_HEADERS = /^(proxy-connection|proxy-authorization|connection|keep-alive)\s*:/i;

export function createForwarder(opts: ForwarderOptions): Forwarder {
	const timeoutMs = opts.timeoutMs ?? 15_000;
	const live = new Map<Socket, { kind: Kind; key: string }>();
	/** Every connection, routed or not, for close(). */
	const clients = new Set<Socket>();
	const servers: Server[] = [];
	const lastKey: Record<Kind, string | undefined> = { browser: undefined, server: undefined };
	let lastLogged = "";
	const log = (line: string) => {
		// A failing proxy fails every request: say it once, not once per request.
		if (line === lastLogged) return;
		lastLogged = line;
		(opts.log ?? ((l: string) => console.error(`[ateam-proxy] ${l}`)))(line);
	};

	const route = (kind: Kind): Route => {
		const config = readProxyConfig(opts.configPath);
		let r: Route = { key: "direct", up: null };
		if (config.url && config[kind]) {
			try {
				r = { key: `proxy ${config.url}`, up: parseProxyUrl(config.url) };
			} catch (e) {
				// Saved through proxy:update, so only a hand edit lands here. Fail closed.
				r = { key: `bad ${config.url}`, up: null, error: (e as Error).message };
			}
		}
		if (lastKey[kind] !== undefined && lastKey[kind] !== r.key) {
			for (const [sock, at] of live) if (at.kind === kind && at.key !== r.key) sock.destroy();
		}
		lastKey[kind] = r.key;
		return r;
	};

	const track = (sock: Socket, kind: Kind, key: string) => {
		live.set(sock, { kind, key });
		sock.once("close", () => live.delete(sock));
	};

	/** A route's way to the target itself, or the reason there is none. */
	const open = (r: Route, host: string, port: number): Promise<Socket> => {
		if (r.error) return Promise.reject(new ProxyError(r.error));
		return r.up ? openTunnel(r.up, host, port, timeoutMs) : dialDirect(host, port, timeoutMs);
	};

	const fail = (client: Socket, why: string) => {
		log(why);
		reply(client, 502, why, { "X-Ateam-Proxy-Error": headerSafe(why) });
	};

	const onConnect = async (kind: Kind, client: Socket, target: string) => {
		const r = route(kind);
		track(client, kind, r.key);
		const at = authority(target);
		if (!at) return reply(client, 400, "CONNECT needs host:port.");
		let out: Socket;
		try {
			out = await open(r, at.host, at.port);
		} catch (e) {
			return fail(client, (e as Error).message);
		}
		if (client.destroyed) return void out.destroy();
		track(out, kind, r.key);
		client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		splice(client, out);
	};

	const onPlain = async (
		kind: Kind,
		client: Socket,
		method: string,
		url: URL,
		version: string,
		headers: string[],
	) => {
		const r = route(kind);
		track(client, kind, r.key);
		if (r.error) return fail(client, r.error);
		const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
		const port = Number(url.port) || 80;
		const kept = headers.filter((h) => !HOP_HEADERS.test(h));
		if (!kept.some((h) => /^host\s*:/i.test(h))) kept.unshift(`Host: ${url.host}`);
		// An HTTP proxy takes the request whole, as any client would send it; SOCKS
		// and straight out reach the site itself, which takes it from its path.
		const viaHttpProxy = r.up !== null && r.up.scheme !== "socks5";
		const auth = viaHttpProxy && r.up ? basicAuth(r.up) : null;
		const head = [
			`${method} ${viaHttpProxy ? url.href : `${url.pathname}${url.search}`} ${version}`,
			...kept,
			...(auth ? [`Proxy-Authorization: ${auth}`] : []),
			"Connection: close",
		].join("\r\n");
		let out: Socket;
		try {
			out = viaHttpProxy && r.up ? await dialProxy(r.up, timeoutMs) : await open(r, host, port);
		} catch (e) {
			return fail(client, (e as Error).message);
		}
		if (client.destroyed) return void out.destroy();
		track(out, kind, r.key);
		out.write(`${head}\r\n\r\n`);
		if (!viaHttpProxy || !r.up) return splice(client, out);
		// The body (if any) goes on while the answer's head is read: never hand a
		// client the proxy's 407, or Chrome opens a sign-in dialog nobody answers.
		client.pipe(out);
		const reader = new HandshakeReader(out, "the proxy");
		let answer: string;
		try {
			answer = await reader.head();
		} catch (e) {
			reader.release();
			out.destroy();
			return fail(client, (e as Error).message);
		}
		if (Number(answer.split(" ", 2)[1]) === 407) {
			reader.release();
			out.destroy();
			return fail(client, refusal(407, r.up, url.host).message);
		}
		client.write(`${answer}\r\n\r\n`);
		splice(client, reader.release(), false);
	};

	const onClient = async (kind: Kind, client: Socket) => {
		client.on("error", () => {});
		clients.add(client);
		client.once("close", () => clients.delete(client));
		const reader = new HandshakeReader(client, "the client");
		let head: string;
		try {
			head = await reader.head();
		} catch {
			reader.release();
			client.destroy();
			return;
		}
		reader.release();
		const [requestLine = "", ...headers] = head.split("\r\n");
		const [method, target, version] = requestLine.split(" ");
		if (!method || !target || !version?.startsWith("HTTP/")) return reply(client, 400, "Not HTTP.");
		if (method === "CONNECT") return onConnect(kind, client, target);
		if (target === FORWARDER_HEALTH_PATH) {
			return reply(
				client,
				200,
				JSON.stringify({ name: "ateam-proxy", version: FORWARDER_VERSION, pid: process.pid }),
				{ "Content-Type": "application/json" },
			);
		}
		let url: URL;
		try {
			url = new URL(target);
			if (url.protocol !== "http:") throw new Error();
		} catch {
			return reply(client, 400, "This is the box's proxy forwarder: send it proxy requests.");
		}
		return onPlain(kind, client, method, url, version, headers);
	};

	return {
		listen(kind, port, host = "127.0.0.1") {
			const server = createServer((sock) => void onClient(kind, sock));
			servers.push(server);
			return new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, host, () => {
					server.removeListener("error", reject);
					resolve(server);
				});
			});
		},
		refresh() {
			route("browser");
			route("server");
		},
		async close() {
			for (const sock of [...live.keys(), ...clients]) sock.destroy();
			await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
		},
	};
}

/** Both ways, until either side is done; `both` false when client → out is piped already. */
function splice(client: Socket, out: Socket, both = true): void {
	out.on("error", () => client.destroy());
	out.on("close", () => client.destroy());
	client.on("close", () => out.destroy());
	if (both) client.pipe(out);
	out.pipe(client);
}

const REASONS: Record<number, string> = { 200: "OK", 400: "Bad Request", 502: "Bad Gateway" };

/** A whole answer from the forwarder itself, then the connection closes. */
function reply(
	client: Socket,
	status: number,
	text: string,
	headers: Record<string, string> = {},
): void {
	const body = Buffer.from(text.endsWith("\n") ? text : `${text}\n`);
	const lines = [
		`HTTP/1.1 ${status} ${REASONS[status] ?? ""}`,
		...Object.entries({ "Content-Type": "text/plain", ...headers }).map(([k, v]) => `${k}: ${v}`),
		`Content-Length: ${body.length}`,
		"Connection: close",
	];
	client.end(Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`), body]));
	// Read on to the client's own end: a paused socket never sees it, and would
	// stay half-open for as long as the client keeps its side.
	client.resume();
}

/** `host:port` from a CONNECT line; brackets off an IPv6 host. */
function authority(text: string): { host: string; port: number } | null {
	try {
		const u = new URL(`http://${text}`);
		const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
		return host ? { host, port: Number(u.port) || 443 } : null;
	} catch {
		return null;
	}
}

/** One line of plain ASCII, safe in a response header. */
function headerSafe(text: string): string {
	return text.replace(/[^\x20-\x7e]/g, " ").slice(0, 300);
}

/**
 * `ateam proxy`: run the forwarder until stopped. The engine starts it detached
 * and names the ports in ATEAM_PROXY_PORTS (`<browser>,<server>`), so the two
 * can never disagree on where it listens.
 */
export async function runForwarder(dataDir: string): Promise<void> {
	const ports = parsePorts(process.env.ATEAM_PROXY_PORTS) ?? DEFAULT_PROXY_PORTS;
	const configPath = proxyConfigPath(dataDir);
	const forwarder = createForwarder({ configPath });
	try {
		await forwarder.listen("browser", ports.browser);
		await forwarder.listen("server", ports.server);
	} catch (e) {
		console.error(
			`[ateam-proxy] can't listen on ${ports.browser},${ports.server}: ${(e as Error).message}`,
		);
		process.exit(1);
	}
	// A change also lands on the next connection; this closes old tunnels sooner.
	watchFile(configPath, { interval: 1000 }, () => forwarder.refresh());
	process.on("SIGTERM", () => process.exit(0));
	console.error(
		`[ateam-proxy] listening on 127.0.0.1:${ports.browser} (browser) and :${ports.server} (server)`,
	);
}

export function parsePorts(text: string | undefined): ProxyPorts | null {
	const [browser, server] = (text ?? "").split(",").map(Number);
	return browser && server ? { browser, server } : null;
}
