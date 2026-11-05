// `ateamgo://pair?…`: the link in the QR a Mac shows, opened by the iPhone's Camera or
// scanned in the app. Two forms: `host=…&port=…&code=…` names one locked box (a box's
// own Pair a phone); `b=host,port,code` once per box puts every box the Mac holds on
// the phone in one scan (Settings → Boxes → Pair your iPhone), with no code for an
// open box, which is added by its address alone. Any app or web page can open a link
// with this scheme, so it is parsed strictly here and the app asks before acting on
// it (App.tsx).
import { boxKey } from "./boxes";
import type { SavedConnection } from "./storage";

/** A pairing code as shown or typed: 8 letters and digits, with or without its dash. */
const PAIR_CODE = /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/;

/** A plain host: a name, an IPv4 address, or an IPv6 one in brackets. */
const HOST = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]{1,253})$/;

/** More boxes than any Mac holds: a link with more is not one of ours. */
const MAX_BOXES = 50;

export interface PairLink {
	box: SavedConnection;
	/** Null for an open box, which needs none. */
	code: string | null;
}

/** The boxes a pairing link names, or null for anything malformed. */
export function parsePairLinks(url: string): PairLink[] | null {
	if (!url.startsWith("ateamgo://pair?") && !url.startsWith("ateamgo://pair/?")) return null;
	const query = url.slice(url.indexOf("?") + 1).split("#")[0] ?? "";
	const params: [string, string][] = [];
	for (const part of query.split("&")) {
		const at = part.indexOf("=");
		if (at < 0) continue;
		try {
			params.push([part.slice(0, at), decodeURIComponent(part.slice(at + 1))]);
		} catch {
			return null;
		}
	}
	const many = params.filter(([k]) => k === "b").map(([, v]) => v);
	if (many.length > MAX_BOXES) return null;
	if (many.length) {
		const out: PairLink[] = [];
		for (const entry of many) {
			const [host, port, code, ...extra] = entry.split(",");
			const link = extra.length ? null : pairLink(host, port, code, true);
			if (!link) return null;
			out.push(link);
		}
		return out;
	}
	const param = (name: string) => params.find(([k]) => k === name)?.[1] ?? "";
	const one = pairLink(param("host"), param("port"), param("code"), false);
	return one ? [one] : null;
}

function pairLink(
	host: string | undefined,
	port: string | undefined,
	code: string | undefined,
	codeMayBeEmpty: boolean,
): PairLink | null {
	const p = port || "8787";
	if (!host || !HOST.test(host)) return null;
	if (!/^\d{1,5}$/.test(p) || Number(p) < 1 || Number(p) > 65535) return null;
	if (!code) return codeMayBeEmpty ? { box: { host, port: p }, code: null } : null;
	return PAIR_CODE.test(code) ? { box: { host, port: p }, code } : null;
}

/** The box a link pairs: the one saved at that address, as saved (with its provider,
 *  so the phone can still wake it), else the bare address, to be added. */
export function pairTarget<B extends SavedConnection>(
	saved: readonly B[],
	link: PairLink,
): B | SavedConnection {
	const key = boxKey(link.box);
	return saved.find((b) => boxKey(b) === key) ?? link.box;
}
