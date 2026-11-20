import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BoxProxy, health } from "../src/proxy";
import {
	chromeProxyPolicy,
	type ProxyConfig,
	proxyConfigPath,
	writeProxyConfig,
} from "../src/proxy/config";
import { createForwarder, type Forwarder } from "../src/proxy/forwarder";

const execFileAsync = promisify(execFile);

// ---- helpers: servers ----

function listen(server: { listen: Server["listen"]; address: Server["address"] }): Promise<number> {
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
	);
}

async function freePort(): Promise<number> {
	const s = createServer();
	const port = await listen(s);
	await new Promise((r) => s.close(r));
	return port;
}

/** Bytes as they come, in exact amounts; then the socket back, paused, nothing lost. */
function byteReader(sock: Socket) {
	let buf = Buffer.alloc(0);
	let wake: (() => void) | null = null;
	const onData = (d: Buffer) => {
		buf = Buffer.concat([buf, d]);
		wake?.();
	};
	sock.on("data", onData);
	const until = async <T>(take: () => T | undefined): Promise<T> => {
		for (;;) {
			const got = take();
			if (got !== undefined) return got;
			await new Promise<void>((r) => {
				wake = r;
			});
		}
	};
	return {
		read: (n: number) =>
			until(() => {
				if (buf.length < n) return undefined;
				const out = buf.subarray(0, n);
				buf = buf.subarray(n);
				return out;
			}),
		head: () =>
			until(() => {
				const i = buf.indexOf("\r\n\r\n");
				if (i < 0) return undefined;
				const out = buf.subarray(0, i).toString();
				buf = buf.subarray(i + 4);
				return out;
			}),
		done() {
			sock.removeListener("data", onData);
			sock.pause();
			if (buf.length) sock.unshift(buf);
		},
	};
}

/** Test targets are named target.test, which only the proxies here can resolve. */
const resolveHost = (host: string) => (host === "target.test" ? "127.0.0.1" : host);

function splice(a: Socket, b: Socket) {
	a.on("error", () => b.destroy());
	b.on("error", () => a.destroy());
	a.pipe(b);
	b.pipe(a);
}

/** An HTTP proxy that wants a username and password, and remembers what it was asked. */
function fakeHttpProxy(creds: { user: string; pass: string }) {
	const seen: { line: string; auth: string | undefined }[] = [];
	const want = `Basic ${Buffer.from(`${creds.user}:${creds.pass}`).toString("base64")}`;
	const server = createServer(async (client) => {
		client.on("error", () => {});
		const r = byteReader(client);
		const [line = "", ...headers] = (await r.head()).split("\r\n");
		const auth = headers.find((h) => /^proxy-authorization:/i.test(h))?.replace(/^[^:]+:\s*/, "");
		seen.push({ line, auth });
		if (auth !== want) {
			client.end(
				'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="p"\r\nContent-Length: 0\r\n\r\n',
			);
			return;
		}
		const [method = "", target = ""] = line.split(" ");
		if (method === "CONNECT") {
			const [host = "", port] = target.split(":");
			const out = connect(Number(port), resolveHost(host), () => {
				client.write("HTTP/1.1 200 Connection established\r\n\r\n");
				r.done();
				splice(client, out);
			});
			out.on("error", () => client.destroy());
			return;
		}
		const url = new URL(target);
		const out = connect(Number(url.port), resolveHost(url.hostname), () => {
			const kept = headers.filter((h) => !/^proxy-/i.test(h));
			out.write(`${method} ${url.pathname}${url.search} HTTP/1.1\r\n${kept.join("\r\n")}\r\n\r\n`);
			r.done();
			splice(client, out);
		});
		out.on("error", () => client.destroy());
	});
	return { server, seen };
}

/** A SOCKS5 proxy with username/password, remembering the targets as it got them. */
function fakeSocks5(creds: { user: string; pass: string }) {
	const targets: string[] = [];
	const server = createServer(async (client) => {
		client.on("error", () => {});
		const r = byteReader(client);
		const [, n = 0] = await r.read(2);
		const methods = [...(await r.read(n))];
		if (!methods.includes(2)) return void client.end(Buffer.from([5, 0xff]));
		client.write(Buffer.from([5, 2]));
		const [, ulen = 0] = await r.read(2);
		const user = (await r.read(ulen)).toString();
		const [plen = 0] = await r.read(1);
		const pass = (await r.read(plen)).toString();
		if (user !== creds.user || pass !== creds.pass) return void client.end(Buffer.from([1, 1]));
		client.write(Buffer.from([1, 0]));
		const [, , , type] = await r.read(4);
		let host = "";
		if (type === 3) {
			const [len = 0] = await r.read(1);
			host = (await r.read(len)).toString();
		} else if (type === 1) host = [...(await r.read(4))].join(".");
		const port = (await r.read(2)).readUInt16BE(0);
		targets.push(`${host}:${port}`);
		const out = connect(port, resolveHost(host), () => {
			client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
			r.done();
			splice(client, out);
		});
		out.on("error", () => client.destroy());
	});
	return { server, targets };
}

// ---- helpers: a client, as Chrome or curl talks to the forwarder ----

function readAll(sock: Socket): Promise<string> {
	return new Promise((resolve, reject) => {
		let text = "";
		sock.on("data", (d) => {
			text += d;
		});
		sock.on("end", () => resolve(text));
		sock.on("close", () => resolve(text));
		sock.on("error", reject);
		sock.resume();
	});
}

async function dial(port: number): Promise<Socket> {
	const sock = connect(port, "127.0.0.1");
	await once(sock, "connect");
	return sock;
}

/** CONNECT, then a request inside the tunnel. */
async function viaConnect(port: number, target: string) {
	const sock = await dial(port);
	sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
	const r = byteReader(sock);
	const head = await r.head();
	const status = Number(head.split(" ")[1]);
	r.done();
	if (status !== 200) {
		sock.destroy();
		return { status, head, body: "" };
	}
	sock.write(`GET /tunnel HTTP/1.0\r\nHost: ${target}\r\n\r\n`);
	const all = await readAll(sock);
	return { status, head, body: all.slice(all.indexOf("\r\n\r\n") + 4) };
}

/** A plain http:// request, absolute URI, as a browser sends one to a proxy. */
async function viaPlain(port: number, url: string) {
	const sock = await dial(port);
	sock.write(
		`GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\nProxy-Connection: keep-alive\r\n\r\n`,
	);
	const all = await readAll(sock);
	return {
		status: Number(all.split(" ")[1]),
		head: all.slice(0, all.indexOf("\r\n\r\n")),
		body: all.slice(all.indexOf("\r\n\r\n") + 4),
	};
}

// ---- shared servers ----

const creds = { user: "user-nl", pass: "s3cret" };
const httpProxy = fakeHttpProxy(creds);
const socks = fakeSocks5(creds);
const target = createHttpServer((req, res) => res.end(`hello ${req.method} ${req.url}`));
let httpProxyPort = 0;
let socksPort = 0;
let targetPort = 0;
let deadPort = 0;

beforeAll(async () => {
	httpProxyPort = await listen(httpProxy.server);
	socksPort = await listen(socks.server);
	targetPort = await listen(target);
	deadPort = await freePort();
});
afterAll(() => {
	httpProxy.server.close();
	socks.server.close();
	target.close();
});

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ateam-proxy-"));
	httpProxy.seen.length = 0;
	socks.targets.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---- the forwarder ----

describe("forwarder", () => {
	let fw: Forwarder;
	let browserPort = 0;
	let serverPort = 0;
	const save = (config: ProxyConfig) => writeProxyConfig(proxyConfigPath(dir), config);
	const proxied = (url: string): ProxyConfig => ({ url, browser: true, server: false });

	beforeEach(async () => {
		fw = createForwarder({ configPath: proxyConfigPath(dir), timeoutMs: 2000, log: () => {} });
		browserPort = ((await fw.listen("browser", 0)).address() as AddressInfo).port;
		serverPort = ((await fw.listen("server", 0)).address() as AddressInfo).port;
	});
	afterEach(() => fw.close());

	it("tunnels through an HTTP proxy, adding its username and password", async () => {
		save(proxied(`http://${creds.user}:${creds.pass}@127.0.0.1:${httpProxyPort}`));
		const r = await viaConnect(browserPort, `target.test:${targetPort}`);
		expect(r.status).toBe(200);
		expect(r.body).toBe("hello GET /tunnel");
		expect(httpProxy.seen).toEqual([
			{
				line: `CONNECT target.test:${targetPort} HTTP/1.1`,
				auth: `Basic ${Buffer.from("user-nl:s3cret").toString("base64")}`,
			},
		]);
	});

	it("sends a plain http:// request to an HTTP proxy whole, with its credentials", async () => {
		save(proxied(`http://${creds.user}:${creds.pass}@127.0.0.1:${httpProxyPort}`));
		const r = await viaPlain(browserPort, `http://target.test:${targetPort}/plain?x=1`);
		expect(r.body).toBe("hello GET /plain?x=1");
		expect(httpProxy.seen[0]?.line).toBe(`GET http://target.test:${targetPort}/plain?x=1 HTTP/1.1`);
		expect(httpProxy.seen[0]?.auth).toStartWith("Basic ");
	});

	it("goes through SOCKS5 with the name unresolved, so no lookup leaves from the box", async () => {
		save(proxied(`socks5://${creds.user}:${creds.pass}@127.0.0.1:${socksPort}`));
		const tunnel = await viaConnect(browserPort, `target.test:${targetPort}`);
		expect(tunnel.body).toBe("hello GET /tunnel");
		const plain = await viaPlain(browserPort, `http://target.test:${targetPort}/via-socks`);
		expect(plain.body).toBe("hello GET /via-socks");
		expect(socks.targets).toEqual([`target.test:${targetPort}`, `target.test:${targetPort}`]);
	});

	it("never hands the client a 407: a wrong password is a 502 saying so", async () => {
		save(proxied(`http://${creds.user}:wrong@127.0.0.1:${httpProxyPort}`));
		const tunnel = await viaConnect(browserPort, `target.test:${targetPort}`);
		expect(tunnel.status).toBe(502);
		expect(tunnel.head).toContain(
			"X-Ateam-Proxy-Error: the proxy refused its username or password",
		);
		const plain = await viaPlain(browserPort, `http://target.test:${targetPort}/x`);
		expect(plain.status).toBe(502);
		expect(plain.body).toContain("refused its username or password");
	});

	it("fails closed when the proxy is down: no request leaves from the box's own address", async () => {
		save(proxied(`http://127.0.0.1:${deadPort}`));
		const tunnel = await viaConnect(browserPort, `127.0.0.1:${targetPort}`);
		expect(tunnel.status).toBe(502);
		expect(tunnel.head).toContain(`couldn't reach the proxy at http://127.0.0.1:${deadPort}`);
		const plain = await viaPlain(browserPort, `http://127.0.0.1:${targetPort}/x`);
		expect(plain.status).toBe(502);
	});

	it("each port follows its own switch: with Server off, the server port goes straight out", async () => {
		save(proxied(`http://${creds.user}:${creds.pass}@127.0.0.1:${httpProxyPort}`));
		const r = await viaPlain(serverPort, `http://127.0.0.1:${targetPort}/direct`);
		expect(r.body).toBe("hello GET /direct");
		expect(httpProxy.seen).toEqual([]);
	});

	it("closes tunnels opened on a route that changed", async () => {
		save(proxied(`http://${creds.user}:${creds.pass}@127.0.0.1:${httpProxyPort}`));
		const sock = await dial(browserPort);
		sock.write(`CONNECT target.test:${targetPort} HTTP/1.1\r\n\r\n`);
		const r = byteReader(sock);
		expect(await r.head()).toStartWith("HTTP/1.1 200");
		r.done();
		// Flowing, so the end the forwarder sends is read and the socket can close.
		sock.resume();
		const closed = once(sock, "close");
		save({ url: null, browser: false, server: false });
		fw.refresh();
		await closed;
	});

	it("answers its own health check with its version", async () => {
		expect(await health(browserPort)).toEqual({ version: 1, pid: process.pid });
	});

	it("speaks to curl as any HTTP proxy does", async () => {
		save(proxied(`http://${creds.user}:${creds.pass}@127.0.0.1:${httpProxyPort}`));
		// Async: the forwarder answers on this same event loop.
		const { stdout } = await execFileAsync("curl", [
			"-sS",
			"--max-time",
			"5",
			"--noproxy",
			"",
			"-x",
			`http://127.0.0.1:${browserPort}`,
			`http://target.test:${targetPort}/curl`,
		]);
		expect(stdout).toBe("hello GET /curl");
	});
});

// ---- the engine's half ----

describe("BoxProxy", () => {
	let ports: { browser: number; server: number };
	let policy: string | null;
	let policyFails: Error | null;
	let env: NodeJS.ProcessEnv;
	let globalCalls: string[];
	let probe: ReturnType<typeof createHttpServer>;
	let probePort = 0;
	let box: BoxProxy;

	beforeAll(async () => {
		probe = createHttpServer((_req, res) => res.end("fl=1\nip=203.0.113.7\nloc=NL\n"));
		probePort = await listen(probe);
	});
	afterAll(() => probe.close());

	beforeEach(async () => {
		ports = { browser: await freePort(), server: await freePort() };
		policy = null;
		policyFails = null;
		env = { HTTPS_PROXY: "http://corp.example:3128", PATH: "/usr/bin" };
		globalCalls = [];
		box = new BoxProxy({
			dataDir: dir,
			forwarderCommand: [process.execPath, join(import.meta.dir, "fixtures", "proxy-forwarder.ts")],
			ports,
			env,
			readPolicy: () => policy,
			writePolicy: async (json) => {
				if (policyFails) throw policyFails;
				policy = json;
			},
			globalProxy: (e) => {
				globalCalls.push(`on ${e.HTTPS_PROXY}`);
				return () => globalCalls.push("off");
			},
			probe: { host: "127.0.0.1", port: probePort, tls: false, path: "/cdn-cgi/trace" },
			log: () => {},
		});
	});
	afterEach(async () => {
		const running = await health(ports.browser);
		if (running) process.kill(running.pid, "SIGTERM");
	});

	const url = () => `http://${creds.user}:${creds.pass}@127.0.0.1:${httpProxyPort}`;

	it("needs an address before a switch, and refuses the forwarder's own", async () => {
		await expect(box.update({ browser: true })).rejects.toThrow("Add the proxy's address first.");
		await expect(box.update({ url: `http://127.0.0.1:${ports.browser}` })).rejects.toThrow(
			"the box's own forwarder",
		);
		await expect(box.update({ url: "ftp://x:21" })).rejects.toThrow("ftp://");
	});

	it("Browser: starts the forwarder and points Chrome's policy at it; the password stays in the file", async () => {
		const status = await box.update({ url: url(), browser: true });
		expect(status).toEqual({
			address: `http://127.0.0.1:${httpProxyPort}`,
			auth: true,
			browser: true,
			server: false,
			engineFollows: false,
			forwarder: true,
		});
		expect(JSON.stringify(status)).not.toContain(creds.pass);
		expect(policy).toBe(chromeProxyPolicy(ports.browser));
		expect(JSON.parse(policy ?? "{}").ProxySettings.ProxyServer).toBe(
			`http://127.0.0.1:${ports.browser}`,
		);
		const file = proxyConfigPath(dir);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readFileSync(file, "utf8")).toContain(creds.pass);
		// The forwarder the engine started takes Chrome's traffic through the proxy.
		const r = await viaConnect(ports.browser, `target.test:${targetPort}`);
		expect(r.body).toBe("hello GET /tunnel");
		// Server is off: the engine's environment is as it was.
		expect(env.HTTPS_PROXY).toBe("http://corp.example:3128");
	});

	it("Server: sets the proxy variables for what the engine starts, and puts the old ones back", async () => {
		await box.update({ url: url(), server: true });
		expect(env.HTTPS_PROXY).toBe(`http://127.0.0.1:${ports.server}`);
		expect(env.http_proxy).toBe(`http://127.0.0.1:${ports.server}`);
		expect(env.NO_PROXY).toContain("100.64.0.0/10");
		expect(env.NODE_USE_ENV_PROXY).toBe("1");
		expect(globalCalls).toEqual([`on http://127.0.0.1:${ports.server}`]);
		expect((await box.status()).engineFollows).toBe(true);
		expect(policy).toBeNull();

		await box.update({ server: false });
		expect(env.HTTPS_PROXY).toBe("http://corp.example:3128");
		expect(env.http_proxy).toBeUndefined();
		expect(env.NODE_USE_ENV_PROXY).toBeUndefined();
		expect(globalCalls).toEqual([`on http://127.0.0.1:${ports.server}`, "off"]);
	});

	it("removing the address turns both switches off and takes the policy away", async () => {
		await box.update({ url: url(), browser: true, server: true });
		const status = await box.update({ url: null });
		expect(status).toMatchObject({
			address: null,
			browser: false,
			server: false,
			forwarder: false,
		});
		expect(policy).toBeNull();
		expect(env.HTTPS_PROXY).toBe("http://corp.example:3128");
	});

	it("a policy that can't be written leaves everything as it was", async () => {
		policyFails = new Error(
			"Couldn't change the box's Chrome proxy policy: it needs passwordless sudo",
		);
		await expect(box.update({ url: url(), browser: true })).rejects.toThrow("passwordless sudo");
		expect(await box.status()).toMatchObject({ address: null, browser: false });
	});

	it("check: the address sites see through the proxy, and its country", async () => {
		await box.update({ url: url() });
		const r = await box.check();
		expect(r).toMatchObject({ ok: true, ip: "203.0.113.7", country: "NL" });
		expect(httpProxy.seen.at(-1)?.line).toBe(`CONNECT 127.0.0.1:${probePort} HTTP/1.1`);
	});

	it("check: says what is wrong, as a sentence", async () => {
		expect(await box.check()).toEqual({ ok: false, error: "No proxy is set on this box." });
		await box.update({ url: `http://${creds.user}:nope@127.0.0.1:${httpProxyPort}` });
		expect(await box.check()).toEqual({
			ok: false,
			error: "The proxy refused its username or password.",
		});
	});

	it("start() puts a saved setting back in force after a restart", async () => {
		writeProxyConfig(proxyConfigPath(dir), { url: url(), browser: true, server: true });
		box.start();
		await box.update({}); // queued behind start's reconcile
		box.stop();
		expect(policy).toBe(chromeProxyPolicy(ports.browser));
		expect(env.HTTPS_PROXY).toBe(`http://127.0.0.1:${ports.server}`);
		expect((await box.status()).forwarder).toBe(true);
	});
});
