// The boxes the phone has connected to: the connection screen's list, newest first.
// One entry per address, kept until the user deletes it. Persisted by src/storage.ts.
//
// Pure TS, no React Native imports, so it runs under bun test.
import { inputsAt, providerById } from "@ateam/protocol";
import type { SavedConnection } from "./storage";

export interface SavedBox extends SavedConnection {
	/** When the phone last connected to it, in ms. */
	lastUsedAt: number;
}

/** A box is its address: the host (case-insensitive) and the port it's reached at. */
export function boxKey(b: { host: string; port: string }): string {
	return `${b.host.trim().toLowerCase()}:${b.port.trim() || "8787"}`;
}

/** The list after connecting to `conn`: it moves to the top, in place of any entry
 *  at the same address and of the entry it was edited from (`replaces`). */
export function touchBox(
	list: SavedBox[],
	conn: SavedConnection,
	now: number,
	replaces?: string | null,
): SavedBox[] {
	const key = boxKey(conn);
	const rest = list.filter((b) => {
		const k = boxKey(b);
		return k !== key && k !== replaces;
	});
	return [{ ...conn, lastUsedAt: now }, ...rest];
}

export function removeBox(list: SavedBox[], key: string): SavedBox[] {
	return list.filter((b) => boxKey(b) !== key);
}

/** What a card is called: the box's name at its provider, else its host. */
export function boxTitle(b: SavedConnection): string {
	const def = providerById(b.provider?.id);
	const nameInput = def ? inputsAt(def, "box")[0] : undefined;
	const name = nameInput ? (b.provider?.box[nameInput.key] ?? "").trim() : "";
	return name || b.host;
}

/** The line under the title: the address the title doesn't already show, then the provider. */
export function boxSubtitle(b: SavedConnection): string {
	const addr = boxTitle(b) === b.host ? `port ${b.port}` : `${b.host}:${b.port}`;
	const def = providerById(b.provider?.id);
	return def ? `${addr} · ${def.label}` : addr;
}

function isConnection(v: unknown): v is SavedConnection {
	if (typeof v !== "object" || v === null) return false;
	const c = v as Record<string, unknown>;
	return typeof c.host === "string" && c.host.trim() !== "" && typeof c.port === "string";
}

/** The stored list, or, from before the phone kept one, the single connection it
 *  remembered. Anything that doesn't parse as a box is dropped, never thrown. */
export function parseBoxes(rawList: string | null, rawLast: string | null): SavedBox[] {
	const parse = (raw: string | null): unknown => {
		try {
			return raw ? JSON.parse(raw) : null;
		} catch {
			return null;
		}
	};
	const list = parse(rawList);
	if (Array.isArray(list)) {
		return list
			.filter(isConnection)
			.map((b) => ({ ...b, lastUsedAt: Number((b as SavedBox).lastUsedAt) || 0 }));
	}
	const last = parse(rawLast);
	return isConnection(last) ? [{ ...last, lastUsedAt: 0 }] : [];
}
