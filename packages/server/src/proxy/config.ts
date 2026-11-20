// What a box's proxy is set to, and what that setting means to Chrome and to the
// processes the engine starts. One file, `proxy.json` in the data dir, mode 0600:
// it holds the proxy's password, so it is never in settings.json (which every
// client reads) and never travels in settings sync. The engine writes it; the
// forwarder (forwarder.ts) reads it for every new connection.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ProxyConfig {
	/** The proxy as typed (it may carry user:password@), or null for none. */
	url: string | null;
	browser: boolean;
	server: boolean;
}

export interface ProxyPorts {
	/** Chrome's way out (its managed policy points here). */
	browser: number;
	/** Everything else's way out (HTTP(S)_PROXY point here). */
	server: number;
}

/** On loopback, beside TaskWindow (9377). Two ports, so each follows its own switch. */
export const DEFAULT_PROXY_PORTS: ProxyPorts = { browser: 9380, server: 9381 };

/** The forwarder's own route: answers whether it runs, and which build. */
export const FORWARDER_HEALTH_PATH = "/__ateam/proxy";
/** Bumped when the forwarder's behaviour changes, so an engine replaces an older one. */
export const FORWARDER_VERSION = 1;

export function proxyConfigPath(dataDir: string): string {
	return join(dataDir, "proxy.json");
}

/** What is saved, normalised: a switch is only on with an address. Unreadable is "none". */
export function readProxyConfig(path: string): ProxyConfig {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const url = typeof raw.url === "string" && raw.url.trim() ? raw.url.trim() : null;
		return {
			url,
			browser: url !== null && raw.browser === true,
			server: url !== null && raw.server === true,
		};
	} catch {
		return { url: null, browser: false, server: false };
	}
}

/** Atomic, and 0600 from the first byte (the tmp file is created with the mode). */
export function writeProxyConfig(path: string, config: ProxyConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}

export function proxyEnabled(config: ProxyConfig): boolean {
	return config.url !== null && (config.browser || config.server);
}

/**
 * Never through the proxy: this box itself, and the tailnet (its addresses and
 * MagicDNS names), which the proxy can't reach and where the user's other boxes
 * and devices are. Both the CIDR (curl, Go, Python) and the range (Node) are
 * listed; each tool skips the form it doesn't read.
 */
const NO_PROXY = [
	"localhost",
	"127.0.0.1",
	"::1",
	"100.64.0.0/10",
	"100.64.0.0-100.127.255.255",
	".ts.net",
].join(",");

/** The variables the Server switch sets, in both cases, as tools read either. */
export const PROXY_ENV_NAMES = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy",
	"NODE_USE_ENV_PROXY",
] as const;

/**
 * The environment that sends a process's traffic to the forwarder's server port.
 * No password in it: the forwarder adds that, and it speaks plain HTTP to every
 * tool, whatever the proxy itself speaks (a SOCKS proxy included). Node programs
 * only follow these with NODE_USE_ENV_PROXY (Node 22.21+, 24.5+).
 */
export function proxyEnvVars(serverPort: number): Record<(typeof PROXY_ENV_NAMES)[number], string> {
	const url = `http://127.0.0.1:${serverPort}`;
	return {
		HTTP_PROXY: url,
		HTTPS_PROXY: url,
		ALL_PROXY: url,
		NO_PROXY,
		http_proxy: url,
		https_proxy: url,
		all_proxy: url,
		no_proxy: NO_PROXY,
		NODE_USE_ENV_PROXY: "1",
	};
}

/**
 * Chrome's managed policy for the Browser switch. Chrome watches its policy
 * directory and both policies refresh without a restart (ConfigDirPolicyLoader;
 * `dynamic_refresh: true` on ProxySettings and WebRtcIPHandling), so the switch
 * applies to the running browser and agents keep their tabs.
 *
 * WebRtcIPHandling: without it, a page's WebRTC asks a STUN server over UDP,
 * outside the proxy, and learns the box's own address.
 */
export function chromeProxyPolicy(browserPort: number): string {
	return `${JSON.stringify(
		{
			ProxySettings: {
				ProxyMode: "fixed_servers",
				ProxyServer: `http://127.0.0.1:${browserPort}`,
				ProxyBypassList: "localhost,127.0.0.1,[::1],100.64.0.0/10,*.ts.net",
			},
			WebRtcIPHandling: "disable_non_proxied_udp",
		},
		null,
		2,
	)}\n`;
}
