// What this phone saw of its links, in order: the app coming and going, each dial,
// each socket declared dead and why. A box that "keeps dropping" was only ever
// measured from the box's side, where a phone that never arrived looks the same as
// one that left; this is the phone's half, kept across a restart so it can be read
// (and shared) after the fact. Pure TS: time and storage are passed in.

export interface ConnLogEntry {
	/** Epoch ms. */
	at: number;
	/** The box it is about, by its label; null for the app itself. */
	box: string | null;
	event: string;
}

export interface ConnLog {
	add(box: string | null, event: string): void;
	entries(): ConnLogEntry[];
	/** One line per entry, oldest first, times in UTC so they line up with a box's logs. */
	text(): string;
	/** Put back what an earlier run kept (`serialize`), under whatever this run added. */
	restore(raw: string | null): void;
	serialize(): string;
	clear(): void;
	/** Called after every change; returns an unsubscribe. */
	subscribe(fn: () => void): () => void;
}

/** Enough for a few hours of a link that flaps, small enough to share as text. */
export const CONN_LOG_CAP = 500;

export function createConnLog(opts: { cap?: number; now?: () => number } = {}): ConnLog {
	const cap = opts.cap ?? CONN_LOG_CAP;
	const now = opts.now ?? Date.now;
	let list: ConnLogEntry[] = [];
	const subs = new Set<() => void>();
	const changed = () => {
		for (const fn of [...subs]) fn();
	};
	const trim = () => {
		if (list.length > cap) list = list.slice(list.length - cap);
	};
	return {
		add(box, event) {
			list.push({ at: now(), box, event });
			trim();
			changed();
		},
		entries: () => list,
		text: () => list.map(formatEntry).join("\n"),
		restore(raw) {
			if (!raw) return;
			try {
				const kept = (JSON.parse(raw) as unknown[]).filter(isEntry);
				list = [...kept, ...list].sort((a, b) => a.at - b.at);
				trim();
				changed();
			} catch {
				// A log that can't be read is no reason to lose the one being written.
			}
		},
		serialize: () => JSON.stringify(list),
		clear() {
			list = [];
			changed();
		},
		subscribe(fn) {
			subs.add(fn);
			return () => {
				subs.delete(fn);
			};
		},
	};
}

function isEntry(e: unknown): e is ConnLogEntry {
	const x = e as ConnLogEntry | null;
	return (
		!!x &&
		typeof x.at === "number" &&
		typeof x.event === "string" &&
		(x.box === null || typeof x.box === "string")
	);
}

/** `2026-11-14 10:30:41Z  box-name  dial failed after 15000 ms: …` */
export function formatEntry(e: ConnLogEntry): string {
	const t = new Date(e.at)
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "Z");
	return `${t}  ${e.box ?? "app"}  ${e.event}`;
}

/** The app's one log (App.tsx wires it to the links, the sockets and storage). */
export const connLog = createConnLog();
