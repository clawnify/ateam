// A raw connection to a target through the user's proxy: HTTP CONNECT for
// http:// and https:// proxies, the SOCKS5 handshake (RFC 1928, with RFC 1929
// username/password) for socks5://. Target names go to the proxy unresolved, so
// no lookup leaves from the box's own address. Errors are sentences for the
// user, and never carry the proxy's username or password.
import { isIP, connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { type ProxyUpstream, proxyAddress } from "@ateam/protocol";

export class ProxyError extends Error {}

export function basicAuth(up: ProxyUpstream): string | null {
	if (up.username === undefined && up.password === undefined) return null;
	return `Basic ${Buffer.from(`${up.username ?? ""}:${up.password ?? ""}`).toString("base64")}`;
}

/** A socket to the proxy itself: TLS for an https:// proxy. */
export function dialProxy(up: ProxyUpstream, timeoutMs: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const tls = up.scheme === "https";
		const sock: Socket = tls
			? tlsConnect({
					host: up.host,
					port: up.port,
					servername: isIP(up.host) ? undefined : up.host,
					ALPNProtocols: ["http/1.1"],
				})
			: netConnect({ host: up.host, port: up.port });
		const fail = (err: Error) => {
			sock.destroy();
			reject(new ProxyError(`couldn't reach the proxy at ${proxyAddress(up)}: ${err.message}`));
		};
		sock.setTimeout(timeoutMs, () => fail(new Error("no answer")));
		sock.once("error", fail);
		sock.once(tls ? "secureConnect" : "connect", () => {
			sock.setTimeout(0);
			sock.removeListener("error", fail);
			resolve(sock);
		});
	});
}

/** A socket straight to the target, for a switch that is off. */
export function dialDirect(host: string, port: number, timeoutMs: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const sock = netConnect({ host, port });
		const fail = (err: Error) => {
			sock.destroy();
			reject(new ProxyError(`couldn't reach ${host}:${port}: ${err.message}`));
		};
		sock.setTimeout(timeoutMs, () => fail(new Error("no answer")));
		sock.once("error", fail);
		sock.once("connect", () => {
			sock.setTimeout(0);
			sock.removeListener("error", fail);
			resolve(sock);
		});
	});
}

/**
 * Reads a socket in exact amounts during a handshake, then hands it back paused,
 * with any bytes read past the handshake put back, so piping it loses nothing.
 */
export class HandshakeReader {
	private buf = Buffer.alloc(0);
	private failed: Error | null = null;
	private wake: (() => void) | null = null;

	constructor(
		private readonly sock: Socket,
		private readonly who: string,
	) {
		sock.on("data", this.onData);
		sock.on("end", this.onEnd);
		sock.on("error", this.onError);
	}

	private readonly onData = (d: Buffer) => {
		this.buf = Buffer.concat([this.buf, d]);
		this.wake?.();
	};
	private readonly onEnd = () => {
		this.failed ??= new ProxyError(`${this.who} closed the connection`);
		this.wake?.();
	};
	private readonly onError = (e: Error) => {
		this.failed ??= new ProxyError(`${this.who}: ${e.message}`);
		this.wake?.();
	};

	private async until<T>(take: () => T | undefined): Promise<T> {
		for (;;) {
			const got = take();
			if (got !== undefined) return got;
			if (this.failed) throw this.failed;
			await new Promise<void>((r) => {
				this.wake = r;
			});
			this.wake = null;
		}
	}

	read(n: number): Promise<Buffer> {
		return this.until(() => {
			if (this.buf.length < n) return undefined;
			const out = this.buf.subarray(0, n);
			this.buf = this.buf.subarray(n);
			return out;
		});
	}

	/** An HTTP head, up to its blank line (not included). */
	head(max = 16_384): Promise<string> {
		return this.until(() => {
			const end = this.buf.indexOf("\r\n\r\n");
			if (end < 0) {
				if (this.buf.length > max)
					throw new ProxyError(`${this.who} sent an answer too long to read`);
				return undefined;
			}
			const out = this.buf.subarray(0, end).toString("latin1");
			this.buf = this.buf.subarray(end + 4);
			return out;
		});
	}

	release(): Socket {
		this.sock.removeListener("data", this.onData);
		this.sock.removeListener("end", this.onEnd);
		this.sock.removeListener("error", this.onError);
		this.sock.pause();
		if (this.buf.length) this.sock.unshift(this.buf);
		return this.sock;
	}
}

/** What a refusal means, without echoing anything the proxy sent back. */
export function refusal(status: number, up: ProxyUpstream, target: string): ProxyError {
	if (status === 407)
		return new ProxyError(
			basicAuth(up)
				? "the proxy refused its username or password"
				: "the proxy wants a username and password: add them to its address",
		);
	return new ProxyError(
		status
			? `the proxy answered ${status} for ${target}`
			: `the proxy at ${proxyAddress(up)} answered something that isn't HTTP`,
	);
}

/** A connection to `host:port` through the proxy, ready to carry any bytes. */
export async function openTunnel(
	up: ProxyUpstream,
	host: string,
	port: number,
	timeoutMs = 15_000,
): Promise<Socket> {
	const sock = await dialProxy(up, timeoutMs);
	const reader = new HandshakeReader(sock, `the proxy at ${proxyAddress(up)}`);
	sock.setTimeout(timeoutMs, () => sock.destroy(new Error("no answer")));
	try {
		if (up.scheme === "socks5") {
			await socks5Connect(sock, reader, up, host, port);
		} else {
			const authority = `${host.includes(":") ? `[${host}]` : host}:${port}`;
			const auth = basicAuth(up);
			sock.write(
				`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`,
			);
			const status = Number((await reader.head()).split("\r\n", 1)[0]?.split(" ")[1]);
			if (status < 200 || status > 299) throw refusal(status || 0, up, authority);
		}
		sock.setTimeout(0);
		return reader.release();
	} catch (e) {
		reader.release();
		sock.destroy();
		throw e;
	}
}

const SOCKS_REPLIES: Record<number, string> = {
	1: "the proxy failed",
	2: "the proxy's rules don't allow it",
	3: "network unreachable",
	4: "host unreachable",
	5: "connection refused",
	6: "timed out",
	7: "command not supported",
	8: "address type not supported",
};

async function socks5Connect(
	sock: Socket,
	reader: HandshakeReader,
	up: ProxyUpstream,
	host: string,
	port: number,
): Promise<void> {
	const withAuth = basicAuth(up) !== null;
	// Offer "no auth", and username/password when there are credentials.
	sock.write(Buffer.from(withAuth ? [5, 2, 0, 2] : [5, 1, 0]));
	const [version, method] = await reader.read(2);
	if (version !== 5) throw new ProxyError(`${proxyAddress(up)} isn't a SOCKS5 proxy`);
	if (method === 2) {
		const user = Buffer.from(up.username ?? "");
		const pass = Buffer.from(up.password ?? "");
		if (user.length > 255 || pass.length > 255)
			throw new ProxyError("the proxy's username or password is longer than SOCKS5 allows");
		sock.write(
			Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]),
		);
		const [, status] = await reader.read(2);
		if (status !== 0) throw new ProxyError("the proxy refused its username or password");
	} else if (method !== 0) {
		throw new ProxyError(
			withAuth
				? "the proxy accepts none of the ways the box can sign in"
				: "the proxy wants a username and password: add them to its address",
		);
	}
	sock.write(
		Buffer.concat([
			Buffer.from([5, 1, 0]),
			socksAddress(host),
			Buffer.from([port >> 8, port & 0xff]),
		]),
	);
	const [v, reply, , type] = await reader.read(4);
	if (v !== 5 || reply !== 0)
		throw new ProxyError(
			`the proxy couldn't reach ${host}:${port}: ${SOCKS_REPLIES[reply ?? 1] ?? `SOCKS error ${reply}`}`,
		);
	// The address the proxy bound, which nothing here needs: read past it.
	const length =
		type === 1 ? 4 : type === 4 ? 16 : type === 3 ? (await reader.read(1))[0] : undefined;
	if (length === undefined)
		throw new ProxyError(`${proxyAddress(up)} sent a SOCKS5 answer it can't read`);
	await reader.read(length + 2);
}

function socksAddress(host: string): Buffer {
	const kind = isIP(host);
	if (kind === 4) return Buffer.from([1, ...host.split(".").map(Number)]);
	if (kind === 6) return Buffer.concat([Buffer.from([4]), ipv6Bytes(host)]);
	const name = Buffer.from(host);
	if (name.length > 255) throw new ProxyError(`${host.slice(0, 40)}… is longer than SOCKS5 allows`);
	return Buffer.concat([Buffer.from([3, name.length]), name]);
}

function ipv6Bytes(ip: string): Buffer {
	let text = ip;
	// A trailing IPv4 (::ffff:1.2.3.4) is the last two groups.
	const v4 = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (v4) {
		const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
		text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const [head = "", tail] = text.split("::");
	const groups = (s: string) => (s ? s.split(":") : []);
	const left = groups(head);
	const right = tail === undefined ? [] : groups(tail);
	const all =
		tail === undefined
			? left
			: [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
	const out = Buffer.alloc(16);
	all.forEach((g, i) => {
		out.writeUInt16BE(Number.parseInt(g, 16), i * 2);
	});
	return out;
}
