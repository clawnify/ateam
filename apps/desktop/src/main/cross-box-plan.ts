// Which links each box should hold for cross-box (cross-box.ts), worked out from
// what the Mac knows: pure, so it is tested on its own.

import { type BoxLinkDTO, boxSupports } from "@ateam/protocol";

export interface CrossBoxBox {
	alias: string;
	version: number;
	wsAddr: string | null;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Where the other boxes reach `box`, or why they can't. */
export function linkUrlOf(
	box: Pick<CrossBoxBox, "alias" | "wsAddr">,
): { url: string } | { problem: string } {
	// A box reached by address: the others reach it at that same address.
	if (/^(\[[0-9A-Fa-f:.]+\]|[^\s/:[\]]+):\d+$/.test(box.alias)) return { url: `ws://${box.alias}` };
	const addr = box.wsAddr;
	const at = addr ? addr.lastIndexOf(":") : -1;
	if (!addr || at <= 0)
		return {
			problem:
				"Other boxes can't reach it: it has no network port (the one Ateam Go uses). Install it with one to link it.",
		};
	const host = addr.slice(0, at);
	if (LOOPBACK.has(host))
		return {
			problem:
				"Other boxes can't reach it: its network port listens on that box alone (127.0.0.1).",
		};
	const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
	return { url: `ws://${bracketed}${addr.slice(at)}` };
}

/** The `ateamgo://pair` link in the QR for pairing a phone with `box`: the phone
 *  reaches it where the other boxes do. Null when no other device can reach it. */
export function pairLinkOf(
	box: Pick<CrossBoxBox, "alias" | "wsAddr">,
	code: string,
): string | null {
	const at = linkUrlOf(box);
	const m = "url" in at ? /^ws:\/\/(.+):(\d+)$/.exec(at.url) : null;
	return m
		? `ateamgo://pair?host=${encodeURIComponent(m[1] ?? "")}&port=${m[2]}&code=${encodeURIComponent(code)}`
		: null;
}

/**
 * The links each held box should have. With cross-box on: one to every other held
 * box the others can reach, by its alias, and every link it has now to a box the
 * Mac isn't holding but still knows. Off: none. Plus why a box is left out.
 */
export function planLinks(input: {
	on: boolean;
	held: CrossBoxBox[];
	/** Every box this Mac has connected to and not forgotten. */
	known: ReadonlySet<string>;
	/** Each held box's links now (absent: it couldn't say). */
	current: ReadonlyMap<string, BoxLinkDTO[]>;
}): { want: Map<string, { name: string; url: string }[]>; problems: Map<string, string> } {
	const want = new Map<string, { name: string; url: string }[]>();
	const problems = new Map<string, string>();
	const able: CrossBoxBox[] = [];
	for (const b of input.held) {
		if (boxSupports("crossBox", b.version)) able.push(b);
		else problems.set(b.alias, "Update it to link it with your other boxes.");
	}
	const urlOf = new Map<string, string>();
	for (const b of able) {
		const at = linkUrlOf(b);
		if ("url" in at) urlOf.set(b.alias, at.url);
		else problems.set(b.alias, at.problem);
	}
	const heldNames = new Set(input.held.map((b) => b.alias));
	for (const b of able) {
		if (!input.on) {
			want.set(b.alias, []);
			continue;
		}
		const own = urlOf.get(b.alias);
		const links: { name: string; url: string }[] = [];
		const add = (name: string, url: string) => {
			if (url !== own && !links.some((l) => l.url === url)) links.push({ name, url });
		};
		for (const other of able) {
			const url = urlOf.get(other.alias);
			if (other.alias !== b.alias && url) add(other.alias, url);
		}
		// A box the Mac isn't holding right now: the link stays while it is known.
		for (const l of input.current.get(b.alias) ?? [])
			if (!heldNames.has(l.name) && input.known.has(l.name)) add(l.name, l.url);
		want.set(b.alias, links);
	}
	return { want, problems };
}
