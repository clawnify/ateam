// Cross-box from the Mac (protocol v30). The Mac holds every box, so it sets up the
// links between them (packages/server/src/links.ts): with `client.crossBox` on, each
// box it holds gets a link to every other box that can be reached over the network.
//
// For a new link the Mac asks the box being reached for a one-time code
// (pairing:invite) and hands it to the box that links (links:set), which redeems it
// itself, so the token never comes through here. A box that isn't locked gives no
// code to a connection it can't trust (one over the tailnet rather than SSH): the
// link then connects as any device may, and once that box is locked and refuses
// it, a later pass pairs it. Turned off, or a box forgotten, the links go and
// their pairings on the other boxes are revoked. A box the Mac just isn't holding
// right now keeps its links: the boxes reach each other without the Mac.

import { type BoxLinkDTO, boxSupports, linksClient } from "@ateam/protocol";
import { readSettings, updateSettings } from "@ateam/server";
import { ipcMain } from "electron";
import { type CrossBoxStatusDTO, HOST_CH } from "../shared/host";
import { type CrossBoxBox, linkUrlOf, planLinks } from "./cross-box-plan";
import type { BoxLink, Host } from "./host";

/** How often the links are checked while cross-box is on: a box locked since
 *  refuses the links that weren't paired, and this pairs them. */
const RECHECK_MS = 5 * 60 * 1000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function startCrossBox(
	host: Host,
	log: (line: string) => void = () => {},
): { dispose(): void } {
	const held = (): (CrossBoxBox & { link: BoxLink })[] =>
		host.heldBoxes().flatMap((alias) => {
			const link = host.boxLink(alias);
			return link ? [{ alias, version: link.version, wsAddr: link.wsAddr, link }] : [];
		});

	const known = async (): Promise<Set<string>> =>
		new Set((await host.list()).filter((c) => c.known).map((c) => c.alias));

	const currentLinks = async (boxes: (CrossBoxBox & { link: BoxLink })[]) => {
		const current = new Map<string, BoxLinkDTO[]>();
		await Promise.all(
			boxes
				.filter((b) => boxSupports("crossBox", b.version))
				.map(async (b) => {
					const list = await linksClient(b.link.rpc)
						.list()
						.catch(() => null);
					if (list) current.set(b.alias, list);
				}),
		);
		return current;
	};

	/** A one-time code from `alias` for a new link, or null when it is open and
	 *  gives none to this Mac (the link connects as it is). */
	const codeFrom = async (alias: string): Promise<string | null> => {
		try {
			return (await host.pairingInvite(alias)).code;
		} catch (e) {
			if (/Lock the box first/.test(message(e))) return null;
			throw e;
		}
	};

	async function reconcile(): Promise<void> {
		const on = readSettings().settings.client.crossBox;
		const boxes = held();
		const current = await currentLinks(boxes);
		const { want } = planLinks({ on, held: boxes, known: await known(), current });
		const aliasOfUrl = new Map<string, string>();
		for (const b of boxes) {
			const at = linkUrlOf(b);
			if ("url" in at) aliasOfUrl.set(at.url, b.alias);
		}
		for (const box of boxes) {
			const now = current.get(box.alias);
			const next = want.get(box.alias);
			if (!now || !next) continue;
			// A link not paired yet gets a code whenever the box it reaches gives this
			// Mac one: it is locked (so the link is refused, or soon will be), or this
			// Mac reaches it over SSH. An open box that gives none is used as it is. A
			// paired link is left be, even refused: it was unpaired on that box, on
			// purpose, and stays cut until cross-box is turned off and on.
			const codes = new Map<string, string | null>();
			for (const w of next) {
				const has = now.find((c) => c.url === w.url);
				if (has?.device) continue;
				const target = aliasOfUrl.get(w.url);
				const code = target ? await codeFrom(target).catch(() => null) : null;
				if (code || !has) codes.set(w.url, code);
			}
			const same =
				codes.size === 0 &&
				now.length === next.length &&
				next.every((w) => now.some((c) => c.url === w.url && c.name === w.name));
			if (same) continue;
			try {
				await linksClient(box.link.rpc).set({
					self: box.alias,
					links: next.map((w) => ({ ...w, code: codes.get(w.url) ?? null })),
				});
			} catch (e) {
				log(`[cross-box] ${box.alias}: ${message(e)}`);
				continue;
			}
			// The pairings of links that went, or were paired again, go too.
			for (const c of now) {
				const kept = next.some((w) => w.url === c.url) && !codes.get(c.url);
				const target = aliasOfUrl.get(c.url);
				if (!kept && c.device && target) await host.pairingRevoke(target, c.device).catch(() => {});
			}
		}
	}

	// One pass at a time; a call during one asks for another after it.
	let running: Promise<void> | null = null;
	let again = false;
	const kick = (): Promise<void> => {
		if (running) {
			again = true;
			return running;
		}
		running = (async () => {
			do {
				again = false;
				await reconcile().catch((e) => log(`[cross-box] ${message(e)}`));
			} while (again);
		})().finally(() => {
			running = null;
		});
		return running;
	};

	async function status(): Promise<CrossBoxStatusDTO> {
		const on = readSettings().settings.client.crossBox;
		const boxes = held();
		const current = await currentLinks(boxes);
		const { problems } = planLinks({ on, held: boxes, known: new Set(), current });
		return {
			on,
			boxes: boxes.map((b) => {
				const problem = problems.get(b.alias);
				return {
					alias: b.alias,
					...(problem ? { problem } : {}),
					links: current.get(b.alias) ?? [],
				};
			}),
		};
	}

	ipcMain.handle(HOST_CH.crossBoxStatus, () => status());
	ipcMain.handle(HOST_CH.crossBoxSet, async (_e, on: unknown) => {
		updateSettings({ client: { crossBox: on === true } });
		await kick();
		return status();
	});
	// A box joined or was forgotten: its links, and the others' links to it.
	const stopBoxes = host.onBoxChange((_alias, change) => {
		if (change !== "released" && readSettings().settings.client.crossBox) void kick();
	});
	// This Mac locked a box: the links to it that weren't paired are refused now.
	const stopLocks = host.onLocked(() => {
		if (readSettings().settings.client.crossBox) void kick();
	});
	const timer = setInterval(() => {
		if (readSettings().settings.client.crossBox) void kick();
	}, RECHECK_MS);
	timer.unref?.();

	return {
		dispose() {
			stopBoxes();
			stopLocks();
			clearInterval(timer);
			ipcMain.removeHandler(HOST_CH.crossBoxStatus);
			ipcMain.removeHandler(HOST_CH.crossBoxSet);
		},
	};
}
