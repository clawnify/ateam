// A box's own proxy, the engine's half (protocol proxy.ts). One saved address,
// two switches, applied three ways:
//
//   - the forwarder (forwarder.ts), started here, detached, whenever a switch is
//     on: the one process that holds the proxy's password and talks to it
//   - Browser: Chrome's managed policy points the box's Chrome at the forwarder.
//     The policy folder is root's, so it takes passwordless sudo, which the
//     browser install already needed
//   - Server: HTTP(S)_PROXY in this engine's own environment, which everything it
//     starts inherits (agent sessions, terminals, git, gh, headless turns), and
//     the engine's own requests where its Node can switch them at runtime
//
// Box-only: the box daemon serves these methods (cli.ts), the Mac's engine never.
import { execFile, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import {
	CH,
	type ProxyCheck,
	type ProxyPatch,
	type ProxyStatus,
	type ProxyUpstream,
	parseProxyUrl,
	proxyAddress,
} from "@ateam/protocol";
import type { RpcExtension } from "../rpc";
import {
	chromeProxyPolicy,
	DEFAULT_PROXY_PORTS,
	FORWARDER_HEALTH_PATH,
	FORWARDER_VERSION,
	PROXY_ENV_NAMES,
	type ProxyConfig,
	type ProxyPorts,
	proxyConfigPath,
	proxyEnabled,
	proxyEnvVars,
	readProxyConfig,
	writeProxyConfig,
} from "./config";
import { basicAuth, openTunnel } from "./tunnel";

const CHROME_POLICY_DIR = "/etc/opt/chrome/policies/managed";
export const CHROME_POLICY_FILE = `${CHROME_POLICY_DIR}/ateam-proxy.json`;

/** What proxy:check fetches through the proxy. */
export interface ProbeTarget {
	host: string;
	port: number;
	tls: boolean;
	path: string;
}
/** Cloudflare's trace page: the address a site sees (`ip=`) and its country (`loc=`). No key, no account. */
export const TRACE: ProbeTarget = {
	host: "www.cloudflare.com",
	port: 443,
	tls: true,
	path: "/cdn-cgi/trace",
};

/** Node 24.14+ and 25.4+: send the process's own fetch and http(s) through the env's proxy. */
type GlobalProxy = (env: NodeJS.ProcessEnv) => () => void;
const nodeGlobalProxy =
	(http as unknown as { setGlobalProxyFromEnv?: GlobalProxy }).setGlobalProxyFromEnv ?? null;

export interface BoxProxyOptions {
	dataDir: string;
	/** Runs the forwarder: this engine's own `ateam proxy`. */
	forwarderCommand: string[];
	ports?: ProxyPorts;
	/** The environment the Server switch sets: this process's own. */
	env?: NodeJS.ProcessEnv;
	readPolicy?: () => string | null;
	/** Writes Chrome's managed policy, or removes it for null. */
	writePolicy?: (json: string | null) => Promise<void>;
	globalProxy?: GlobalProxy | null;
	probe?: ProbeTarget;
	log?: (line: string) => void;
}

export class BoxProxy {
	private readonly path: string;
	private readonly ports: ProxyPorts;
	private readonly env: NodeJS.ProcessEnv;
	private readonly readPolicy: () => string | null;
	private readonly writePolicy: (json: string | null) => Promise<void>;
	private readonly globalProxy: GlobalProxy | null;
	private readonly probe: ProbeTarget;
	private readonly log: (line: string) => void;
	/** What the variables were before Server set them, to put back when it's off. */
	private saved: Record<string, string | undefined> | null = null;
	private restoreGlobal: (() => void) | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private timer: ReturnType<typeof setInterval> | null = null;

	readonly extension: RpcExtension = {
		methods: [CH.proxyStatus, CH.proxyUpdate, CH.proxyCheck],
		handle: async (method, args) =>
			method === CH.proxyUpdate
				? this.update(args[0] as ProxyPatch)
				: method === CH.proxyCheck
					? this.check()
					: this.status(),
		subscribe: () => () => {},
	};

	constructor(private readonly opts: BoxProxyOptions) {
		this.path = proxyConfigPath(opts.dataDir);
		this.ports = opts.ports ?? DEFAULT_PROXY_PORTS;
		this.env = opts.env ?? process.env;
		this.readPolicy = opts.readPolicy ?? readChromePolicy;
		this.writePolicy = opts.writePolicy ?? sudoPolicyWriter(opts.dataDir);
		this.globalProxy = opts.globalProxy === undefined ? nodeGlobalProxy : opts.globalProxy;
		this.probe = opts.probe ?? TRACE;
		this.log = opts.log ?? ((line) => console.log(line));
	}

	/**
	 * Put what is saved back in force: after a reboot nothing runs, and the
	 * engine's environment is new on every start. Then keep the forwarder up.
	 */
	start(): void {
		void this.serial(() => this.reconcile());
		this.timer = setInterval(() => {
			if (proxyEnabled(readProxyConfig(this.path)))
				void this.ensureForwarder().catch((e) =>
					this.log(`[ateam] proxy: ${(e as Error).message}`),
				);
		}, 60_000);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	async status(): Promise<ProxyStatus> {
		const config = readProxyConfig(this.path);
		const up = upstreamOf(config);
		return {
			address: up ? proxyAddress(up) : null,
			auth: up !== null && basicAuth(up) !== null,
			browser: config.browser,
			server: config.server,
			engineFollows: config.server && this.restoreGlobal !== null,
			forwarder:
				proxyEnabled(config) && (await health(this.ports.browser))?.version === FORWARDER_VERSION,
		};
	}

	update(patch: ProxyPatch): Promise<ProxyStatus> {
		return this.serial(() => this.apply(patch));
	}

	/** The address sites see through the saved proxy: the proxy itself, not the forwarder. */
	async check(): Promise<ProxyCheck> {
		const config = readProxyConfig(this.path);
		if (!config.url) return { ok: false, error: "No proxy is set on this box." };
		const started = Date.now();
		try {
			const body = await fetchThrough(parseProxyUrl(config.url), this.probe);
			const ip = /^ip=(.+)$/m.exec(body)?.[1]?.trim();
			if (!ip)
				return { ok: false, error: `${this.probe.host} answered without the address it saw.` };
			const country = /^loc=([A-Z]{2})$/m.exec(body)?.[1] ?? null;
			return { ok: true, ip, country, ms: Date.now() - started };
		} catch (e) {
			return { ok: false, error: sentence((e as Error).message) };
		}
	}

	private serial<T>(work: () => Promise<T>): Promise<T> {
		const run = this.queue.then(work);
		this.queue = run.catch(() => {});
		return run;
	}

	private async apply(patch: ProxyPatch): Promise<ProxyStatus> {
		const p = (patch ?? {}) as ProxyPatch;
		for (const key of ["browser", "server"] as const) {
			if (p[key] !== undefined && typeof p[key] !== "boolean")
				throw new Error(`${key} must be true or false.`);
		}
		const before = readProxyConfig(this.path);
		const next: ProxyConfig = { ...before };
		if (p.url !== undefined) {
			if (p.url !== null && typeof p.url !== "string") throw new Error("url must be text or null.");
			if (p.url === null || !p.url.trim()) {
				next.url = null;
				next.browser = false;
				next.server = false;
			} else {
				const up = parseProxyUrl(p.url);
				if (
					isLoopback(up.host) &&
					(up.port === this.ports.browser || up.port === this.ports.server)
				)
					throw new Error("That's the box's own forwarder. Give the address of the proxy itself.");
				next.url = p.url.trim();
			}
		}
		if (p.browser !== undefined) next.browser = p.browser;
		if (p.server !== undefined) next.server = p.server;
		if ((next.browser || next.server) && !next.url)
			throw new Error("Add the proxy's address first.");

		writeProxyConfig(this.path, next);
		try {
			if (proxyEnabled(next)) await this.ensureForwarder();
			await this.applyPolicy(next.browser);
		} catch (e) {
			// Nothing half-applied: back to what was in force before.
			writeProxyConfig(this.path, before);
			await this.applyPolicy(before.browser).catch(() => {});
			throw e;
		}
		this.applyEnv(next.server);
		return this.status();
	}

	private async reconcile(): Promise<void> {
		const config = readProxyConfig(this.path);
		try {
			if (proxyEnabled(config)) await this.ensureForwarder();
		} catch (e) {
			this.log(`[ateam] proxy: ${(e as Error).message}`);
		}
		try {
			await this.applyPolicy(config.browser);
		} catch (e) {
			this.log(`[ateam] proxy: ${(e as Error).message}`);
		}
		this.applyEnv(config.server);
	}

	/** The forwarder answering, at this engine's version. Started if not. */
	private async ensureForwarder(): Promise<void> {
		const found = await health(this.ports.browser);
		if (found?.version === FORWARDER_VERSION) return;
		if (found) {
			// An update shipped a newer forwarder: the old one makes way.
			try {
				process.kill(found.pid, "SIGTERM");
			} catch {}
			await waitFor(async () => (await health(this.ports.browser)) === null, 3000);
		}
		const logPath = join(this.opts.dataDir, "proxy.log");
		const out = openSync(logPath, "a");
		try {
			const [cmd = process.execPath, ...args] = this.opts.forwarderCommand;
			const env: NodeJS.ProcessEnv = { ...process.env };
			// Its own traffic goes straight to the proxy, never back through itself.
			for (const name of PROXY_ENV_NAMES) delete env[name];
			const child = spawn(cmd, args, {
				detached: true,
				stdio: ["ignore", out, out],
				env: {
					...env,
					ATEAM_DATA_DIR: this.opts.dataDir,
					ATEAM_PROXY_PORTS: `${this.ports.browser},${this.ports.server}`,
				},
			});
			child.on("error", () => {});
			child.unref();
		} finally {
			closeSync(out);
		}
		const up = await waitFor(
			async () => (await health(this.ports.browser))?.version === FORWARDER_VERSION,
			5000,
		);
		if (!up) throw new Error(`The box's proxy forwarder didn't start: see ${logPath} there.`);
	}

	private async applyPolicy(on: boolean): Promise<void> {
		const want = on ? chromeProxyPolicy(this.ports.browser) : null;
		if (this.readPolicy() === want) return;
		await this.writePolicy(want);
	}

	private applyEnv(on: boolean): void {
		const env = this.env;
		if (on) {
			this.saved ??= Object.fromEntries(PROXY_ENV_NAMES.map((name) => [name, env[name]]));
			Object.assign(env, proxyEnvVars(this.ports.server));
			if (!this.restoreGlobal && this.globalProxy) {
				try {
					this.restoreGlobal = this.globalProxy(env);
				} catch (e) {
					this.log(`[ateam] proxy: the engine's own requests stay direct: ${(e as Error).message}`);
				}
			}
			return;
		}
		if (this.saved) {
			for (const name of PROXY_ENV_NAMES) {
				const was = this.saved[name];
				if (was === undefined) delete env[name];
				else env[name] = was;
			}
			this.saved = null;
		}
		if (this.restoreGlobal) {
			try {
				this.restoreGlobal();
			} catch {}
			this.restoreGlobal = null;
		}
	}
}

function upstreamOf(config: ProxyConfig): ProxyUpstream | null {
	try {
		return config.url ? parseProxyUrl(config.url) : null;
	} catch {
		return null;
	}
}

function isLoopback(host: string): boolean {
	return host === "localhost" || host === "::1" || /^127\./.test(host);
}

function sentence(text: string): string {
	const t = text.charAt(0).toUpperCase() + text.slice(1);
	return /[.!?]$/.test(t) ? t : `${t}.`;
}

async function waitFor(test: () => Promise<boolean>, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	for (;;) {
		if (await test()) return true;
		if (Date.now() >= end) return false;
		await new Promise((r) => setTimeout(r, 100));
	}
}

/** Read a whole answer from a socket that closes when it's done. */
function readAll(sock: Socket, timeoutMs: number, limit = 64_000): Promise<string> {
	return new Promise((resolve, reject) => {
		let text = "";
		sock.setEncoding("latin1");
		sock.setTimeout(timeoutMs, () => sock.destroy(new Error("no answer")));
		sock.on("data", (d: string) => {
			text += d;
			if (text.length > limit) sock.destroy(new Error("answer too long"));
		});
		sock.on("end", () => resolve(text));
		sock.on("error", reject);
		// A tunnel comes back paused (tunnel.ts), and a listener alone doesn't resume it.
		sock.resume();
	});
}

/** The forwarder's own answer on `port`, or null when nothing (or something else) answers there. */
export async function health(port: number): Promise<{ version: number; pid: number } | null> {
	const sock = netConnect({ host: "127.0.0.1", port });
	try {
		await new Promise<void>((resolve, reject) => {
			sock.once("connect", resolve);
			sock.once("error", reject);
		});
		sock.write(`GET ${FORWARDER_HEALTH_PATH} HTTP/1.0\r\n\r\n`);
		const text = await readAll(sock, 1500);
		const json = JSON.parse(text.slice(text.indexOf("\r\n\r\n") + 4));
		return json?.name === "ateam-proxy"
			? { version: Number(json.version), pid: Number(json.pid) }
			: null;
	} catch {
		return null;
	} finally {
		sock.destroy();
	}
}

/** GET a page through the proxy, over HTTP/1.0 so the answer is never chunked. */
async function fetchThrough(
	up: ProxyUpstream,
	probe: ProbeTarget,
	timeoutMs = 15_000,
): Promise<string> {
	const tunnel = await openTunnel(up, probe.host, probe.port, timeoutMs);
	const sock = probe.tls ? tlsConnect({ socket: tunnel, servername: probe.host }) : tunnel;
	try {
		const answer = readAll(sock, timeoutMs);
		sock.write(
			`GET ${probe.path} HTTP/1.0\r\nHost: ${probe.host}\r\nUser-Agent: ateam-proxy-check\r\nAccept: */*\r\n\r\n`,
		);
		const text = await answer.catch((e: Error) => {
			throw new Error(`${probe.host} didn't answer through the proxy: ${e.message}`);
		});
		const status = Number(text.split(" ", 2)[1]);
		if (status !== 200)
			throw new Error(`${probe.host} answered ${status || "nothing"} through the proxy`);
		return text.slice(text.indexOf("\r\n\r\n") + 4);
	} finally {
		sock.destroy();
		tunnel.destroy();
	}
}

function readChromePolicy(): string | null {
	try {
		return readFileSync(CHROME_POLICY_FILE, "utf8");
	} catch {
		return null;
	}
}

/**
 * Chrome's policy folder belongs to root, and Chrome reads every file in it. So
 * the policy is written beside it and moved in whole, by sudo -n: passwordless
 * sudo, as install-browser.sh needs, and never a prompt.
 */
function sudoPolicyWriter(scratchDir: string): (json: string | null) => Promise<void> {
	return async (json) => {
		if (json === null) return sudo(["rm", "-f", CHROME_POLICY_FILE]);
		const tmp = join(scratchDir, "chrome-proxy-policy.json");
		writeFileSync(tmp, json, { mode: 0o644 });
		try {
			await sudo([
				"sh",
				"-c",
				'mkdir -p "$1" && install -m 644 "$2" "$3" && mv -f "$3" "$1/ateam-proxy.json"',
				"sh",
				CHROME_POLICY_DIR,
				tmp,
				"/etc/opt/chrome/policies/.ateam-proxy.json.new",
			]);
		} finally {
			rmSync(tmp, { force: true });
		}
	};
}

function sudo(args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile("sudo", ["-n", ...args], { timeout: 15_000 }, (err, _out, stderr) => {
			if (!err) return resolve();
			const why = String(stderr).trim().split("\n").pop() || err.message;
			reject(
				new Error(
					`Couldn't change the box's Chrome proxy policy: it needs passwordless sudo, as installing the browser did (${why}).`,
				),
			);
		});
	});
}
