// The boxes the phone has connected to: the connection screen's list, newest first.
// One entry per address, kept until the user deletes it. Persisted by src/storage.ts.
//
// Pure TS, no React Native imports, so it runs under bun test.
import {
	type ConnectStep,
	filled,
	inputsAt,
	NEEDS_PAIRING,
	type ProviderDefinition,
	type ProviderReport,
	providerById,
	reportedWake,
	wakeMachineName,
} from "@ateam/protocol";
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

/** The list once the box at `key` takes what it reported in hello about its provider
 *  (SystemInfo.provider), or null when nothing changes. A box saved by its address
 *  alone (a pairing QR, an IP typed in) has no provider, so the phone dialled it asleep
 *  until it timed out. The provider only fills what is missing: one the user picked
 *  stays, and only its blank name is filled, from a report at the same provider.
 *  Whether it sleeps is the box's own fact, so the latest report always replaces it. */
export function withReportedProvider(
	list: SavedBox[],
	key: string,
	reported: ProviderReport | null | undefined,
): SavedBox[] | null {
	const wake = reportedWake(reported);
	const at = list.findIndex((b) => boxKey(b) === key);
	const box = list[at];
	if (!wake || !reported || !box) return null;
	let next: SavedBox = box;
	const own = providerById(box.provider?.id);
	const fill =
		!own || !box.provider || (own.id === wake.id && !filled(own, "box", box.provider.box));
	if (fill) next = { ...next, provider: wake };
	if (typeof reported.sleeps === "boolean" && box.sleeps !== reported.sleeps) {
		next = { ...next, sleeps: reported.sleeps };
	}
	if (next === box) return null;
	const list2 = [...list];
	list2[at] = next;
	return list2;
}

/** The provider a box goes to sleep through, as far as the phone shows it: its own,
 *  unless the box said it's always on. Drives "asleep" and asking for a key; a tap
 *  still wakes through the provider when a key is saved (links.ts), since a box can
 *  be put back to sleeping after it last said so. */
export function wakesThrough(box: SavedConnection): ProviderDefinition | undefined {
	return box.sleeps === false ? undefined : providerById(box.provider?.id);
}

/** Why this phone can't wake a box its provider puts to sleep, when it can't (no
 *  waker for it): its name there is missing, else the provider's key. Null for a
 *  box with no provider, which nothing wakes. */
export function cantWakeReason(box: SavedConnection): string | null {
	const def = wakesThrough(box);
	if (!def) return null;
	if (!filled(def, "box", box.provider?.box ?? {})) {
		return `This phone doesn't have its name at ${def.label}, so it can't wake it.`;
	}
	const key = inputsAt(def, "account")[0]?.label ?? "key";
	return `This phone has no ${def.label} ${key} to wake it with.`;
}

/** What a box that dropped says until a try says more. */
export const CONNECTION_LOST = "The connection dropped.";

/** Under a box with no provider that isn't answering, and where the phone waits on it. */
export const NO_PROVIDER_HINT =
	"If this box goes to sleep when it's idle, set its provider so this phone can wake it.";

/** A box with no provider that isn't answering: if it sleeps, nothing on the phone can
 *  wake it until the phone knows what it runs on. Read from its last failure, which is
 *  kept while it's tried again, so the hint stays put instead of flickering per try. A
 *  box that just dropped is reconnecting, a locked one answered, and one that said it's
 *  always on has nothing to wake. */
export function needsProvider(box: SavedConnection, link: BoxLink): boolean {
	return (
		box.sleeps !== false &&
		providerById(box.provider?.id) === undefined &&
		link.state !== "live" &&
		link.error !== null &&
		link.error !== NEEDS_PAIRING &&
		link.error !== CONNECTION_LOST
	);
}

export function removeBox(list: SavedBox[], key: string): SavedBox[] {
	return list.filter((b) => boxKey(b) !== key);
}

/** What a card is called: the box's name at its provider, else its host. */
export function boxTitle(b: SavedConnection): string {
	return wakeMachineName(b.provider) || b.host;
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

/** Where the phone's link to one box stands. The board itself is in src/fleet.ts. */
export interface BoxLink {
	state: "live" | "connecting" | "down";
	/** The attempt under way, or the last one, was someone asking for the box (a tap,
	 *  opening something on it), so it wakes it; else a try in the background. */
	asked: boolean;
	/** What reaching it went through, kept after a failure so the failed step shows. */
	steps: ConnectStep[];
	/** Why the last attempt failed (or that its connection dropped), kept while it is
	 *  tried again and cleared once it answers. */
	error: string | null;
	/** The last attempt didn't wake it and it has a provider: down because it sleeps,
	 *  most likely, which is the normal state of a box and not a failure. */
	asleep: boolean;
	/** Why the last wake failed, until a wake or a connect succeeds. */
	wakeError: string | null;
	/** The box's protocol version once it has answered. */
	version: number | null;
	/** Bumps on every connect: keys its open terminal so it remounts onto the fresh link. */
	gen: number;
}

export const NEW_LINK: BoxLink = {
	state: "down",
	asked: false,
	steps: [],
	error: null,
	asleep: false,
	wakeError: null,
	version: null,
	gen: 0,
};

/** Why a box's tasks are out of date right now: it sleeps, or it isn't answering;
 *  null while it is up, or before the first try has said either. */
export function awayOf(link: BoxLink | undefined): "asleep" | "offline" | null {
	if (!link || link.state === "live") return null;
	if (link.asleep) return "asleep";
	return link.error ? "offline" : null;
}

/** The box whose Lead the phone talks to: the one picked in Boxes while it is
 *  still on the list, else the box used last. */
export function leadBoxOf(boxes: SavedBox[], picked: string | null): string | null {
	if (picked && boxes.some((b) => boxKey(b) === picked)) return picked;
	return boxes[0] ? boxKey(boxes[0]) : null;
}

/** The box a new task runs on, out of the boxes its project is on: the one picked
 *  last when the project is on it, else the Lead's box (the phone's home, as Local
 *  is the desktop's), else the first that answers, else the first. */
export function pickRunOn(
	on: string[],
	picked: string | null,
	lead: string | null,
	isLive: (key: string) => boolean,
): string | null {
	if (picked && on.includes(picked)) return picked;
	if (lead && on.includes(lead)) return lead;
	return on.find(isLive) ?? on[0] ?? null;
}

/** `keys` with the Lead's box first, the rest in their order: the home box leads,
 *  as Local does in the desktop's lists. */
export function leadFirst(keys: string[], lead: string | null): string[] {
	if (!lead || !keys.includes(lead)) return keys;
	return [lead, ...keys.filter((k) => k !== lead)];
}
