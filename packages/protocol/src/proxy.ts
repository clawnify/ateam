// A box's own proxy (v39): one proxy address, and two switches for what goes out
// through it. `browser` is the box's Chrome (what agents browse and the Browser
// panel shows); `server` is everything else the box's engine starts (agent CLIs,
// terminals, git, gh) and the engine's own requests. Box-addressed: only a box's
// daemon serves proxy:* (server/src/proxy), never the Mac's own engine.
//
// The address carries the proxy's username and password, so it travels one way,
// like a GitHub token: a client sends it once and gets back only `address` (where
// the proxy is) and `auth` (whether it has credentials).

export interface ProxyStatus {
	/** `scheme://host:port` of the saved proxy, never its username or password. Null: none saved. */
	address: string | null;
	/** The saved address carries a username and password. */
	auth: boolean;
	/** The box's Chrome goes out through it. */
	browser: boolean;
	/** What the engine starts (agents, terminals, git, gh) goes out through it. */
	server: boolean;
	/**
	 * With `server` on, whether the engine's own requests (task titles and
	 * summaries, provider calls) go through it too. False on a box whose Node
	 * can't switch them at runtime (http.setGlobalProxyFromEnv, Node 24.14+).
	 */
	engineFollows: boolean;
	/** While a switch is on: the box's local forwarder answers. Without it, that traffic fails. */
	forwarder: boolean;
}

/** proxy:update's argument. Unset fields keep their value. */
export interface ProxyPatch {
	/**
	 * A new address (`http://`, `https://` or `socks5://`, with an optional
	 * `user:password@`), or null to remove it, which turns both switches off.
	 */
	url?: string | null;
	browser?: boolean;
	server?: boolean;
}

/** proxy:check's answer: the address a site sees through the proxy, or why there is none. */
export type ProxyCheck =
	| { ok: true; ip: string; country: string | null; ms: number }
	| { ok: false; error: string };

export type ProxyScheme = "http" | "https" | "socks5";

export interface ProxyUpstream {
	scheme: ProxyScheme;
	host: string;
	port: number;
	username?: string;
	password?: string;
}

const DEFAULT_PORTS: Record<ProxyScheme, number> = { http: 80, https: 443, socks5: 1080 };

export const PROXY_URL_HINT =
	"Use the proxy's address, like http://user:password@host:port (http, https or socks5).";

/**
 * Parse a proxy address as typed. Throws a sentence for the user when it isn't
 * one. `socks5h://` reads as `socks5://`: the box always lets the proxy resolve
 * names, so a lookup never leaves from the box's own address.
 */
export function parseProxyUrl(raw: string): ProxyUpstream {
	const text = raw.trim();
	if (!text || /\s/.test(text)) throw new Error(PROXY_URL_HINT);
	let url: URL;
	try {
		url = new URL(text.includes("://") ? text : `http://${text}`);
	} catch {
		throw new Error(PROXY_URL_HINT);
	}
	const proto = url.protocol.replace(/:$/, "");
	const scheme: ProxyScheme | null =
		proto === "http" || proto === "https" || proto === "socks5"
			? proto
			: proto === "socks5h"
				? "socks5"
				: null;
	if (!scheme) throw new Error(`${proto}:// isn't a proxy the box can use. ${PROXY_URL_HINT}`);
	const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
	if (!host) throw new Error(PROXY_URL_HINT);
	const port = url.port ? Number(url.port) : DEFAULT_PORTS[scheme];
	const username = url.username ? decodeURIComponent(url.username) : undefined;
	const password = url.password ? decodeURIComponent(url.password) : undefined;
	return {
		scheme,
		host,
		port,
		...(username !== undefined ? { username } : {}),
		...(password !== undefined ? { password } : {}),
	};
}

/** Where the proxy is, for showing: `scheme://host:port`, no credentials. */
export function proxyAddress(up: ProxyUpstream): string {
	const host = up.host.includes(":") ? `[${up.host}]` : up.host;
	return `${up.scheme}://${host}:${up.port}`;
}
