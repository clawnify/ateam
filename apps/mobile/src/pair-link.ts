// `ateamgo://pair?host=…&port=…&code=…`: the link in the QR a paired Mac shows
// (Settings → Boxes → Pair a phone), opened by the iPhone's Camera. Any app or web
// page can open a link with this scheme, so it is parsed strictly here and the app
// asks before acting on it (App.tsx).
import type { SavedConnection } from "./storage";

/** A pairing code as shown or typed: 8 letters and digits, with or without its dash. */
const PAIR_CODE = /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/;

/** A plain host: a name, an IPv4 address, or an IPv6 one in brackets. */
const HOST = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]{1,253})$/;

export interface PairLink {
	box: SavedConnection;
	code: string;
}

/** The box and code a pairing link names, or null for anything malformed. */
export function parsePairLink(url: string): PairLink | null {
	if (!url.startsWith("ateamgo://pair?") && !url.startsWith("ateamgo://pair/?")) return null;
	const param = (name: string): string => {
		const raw = url.match(new RegExp(`[?&]${name}=([^&#]*)`))?.[1] ?? "";
		try {
			return decodeURIComponent(raw);
		} catch {
			return "";
		}
	};
	const host = param("host");
	const port = param("port") || "8787";
	const code = param("code");
	if (!HOST.test(host)) return null;
	if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
	if (!PAIR_CODE.test(code)) return null;
	return { box: { host, port }, code };
}
