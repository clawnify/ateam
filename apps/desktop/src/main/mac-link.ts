// This Mac in its boxes' links (protocol v40). A box can't dial the Mac: it
// sleeps, it has no listener, and a tailnet's rules may let no box reach it. So
// with `client.macLink` on, the Mac offers itself on each connection it holds
// (links:offer) and serves the box back down it (duplex.ts), narrowed to what a
// link may do whatever the box says of itself: read the board and send messages,
// never a terminal, git, or an answer in the user's name. The other way, this
// Mac's own engine gets the boxes it holds as links (BoxLinks.attach), so agents
// here list and message their tasks.
//
// Only boxes on v40 join, in both directions at once: an older one would take a
// Mac task's message and have no way to answer it.

import { boxSupports, linksClient, withTimeout } from "@ateam/protocol";
import {
	type BoxLinks,
	createDispatcher,
	type Engine,
	LinkLimiter,
	readSettings,
	serveRpc,
	updateSettings,
} from "@ateam/server";
import type { MacLinkStatusDTO } from "../shared/host";
import type { BoxLink, Host } from "./host";

/** How long a box may take to reach back and take the offer. */
const OFFER_TIMEOUT_MS = 20_000;

/** What the Mac's agents are told about a box this Mac isn't holding. */
const BOX_AWAY = "this Mac isn't connected to it right now";

const OLD_BOX = "Update Ateam on it to link it with this Mac.";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface MacLink {
	status(): MacLinkStatusDTO;
	/** Turn it on or off, on every box held: answers once each has gone one way or the other. */
	set(on: boolean): Promise<MacLinkStatusDTO>;
	dispose(): void;
}

/** `name` is what this Mac is called on the boxes (host.ts macLabel). Free of
 *  Electron, so a script can run it against a real box (wiki, testing/box-e2e). */
export function startMacLink(
	host: Pick<Host, "boxLink" | "heldBoxes" | "onBoxChange">,
	engine: Engine,
	links: BoxLinks,
	name: string,
	log: (line: string) => void = () => {},
): MacLink {
	// Its own dispatcher: a link's calls never share a window's terminal state.
	const dispatcher = createDispatcher(engine);
	const limiter = new LinkLimiter();
	const joined = new Map<string, { link: BoxLink; leave(): void }>();
	// Every box attached since this was turned on, held or not, to drop them all.
	const attached = new Set<string>();
	const joining = new Map<string, Promise<void>>();
	const problems = new Map<string, string>();
	const on = () => readSettings().settings.client.macLink;

	const leave = (alias: string) => {
		joined.get(alias)?.leave();
		joined.delete(alias);
	};

	// One at a time for a box: a second try would serve the same connection twice.
	const join = (alias: string): Promise<void> => {
		const going = joining.get(alias);
		if (going) return going;
		const run = tryJoin(alias).finally(() => joining.delete(alias));
		joining.set(alias, run);
		return run;
	};

	const tryJoin = async (alias: string): Promise<void> => {
		const link = host.boxLink(alias);
		if (!link || joined.get(alias)?.link === link) return;
		leave(alias);
		if (!boxSupports("macLink", link.version)) {
			problems.set(alias, OLD_BOX);
			return;
		}
		// Serving first: the box says hello back down the connection before it
		// takes the offer.
		const stopServing = serveRpc(engine, dispatcher, link.back, [], {
			link: { name: alias, limiter },
		});
		const stop = () => {
			stopServing();
			// serveRpc keeps answering until its connection ends: take the reader away.
			link.back.onFrame(() => {});
		};
		try {
			await withTimeout(linksClient(link.rpc).offer(name), OFFER_TIMEOUT_MS, "the box");
		} catch (e) {
			stop();
			problems.set(alias, message(e));
			log(`[ateam] linking this Mac with ${alias} failed: ${message(e)}`);
			return;
		}
		// Released, or switched off, while the box was answering.
		if (host.boxLink(alias) !== link || !on()) {
			stop();
			return;
		}
		problems.delete(alias);
		const detach = links.attach(alias, link.rpc, BOX_AWAY);
		attached.add(alias);
		joined.set(alias, {
			link,
			leave: () => {
				stop();
				detach();
			},
		});
		log(`[ateam] this Mac is linked with ${alias}`);
	};

	const joinAll = () => Promise.all(host.heldBoxes().map((alias) => join(alias)));

	const leaveAll = async () => {
		await Promise.all(
			[...joined].map(async ([alias, j]) => {
				// Best effort: the box drops the link when the connection ends anyway.
				await withTimeout(linksClient(j.link.rpc).withdraw(), OFFER_TIMEOUT_MS, "the box").catch(
					() => {},
				);
				leave(alias);
			}),
		);
		for (const alias of attached) links.drop(alias);
		attached.clear();
		problems.clear();
	};

	const status = (): MacLinkStatusDTO => ({
		on: on(),
		name,
		boxes: host.heldBoxes().map((alias) => ({
			alias,
			linked: joined.has(alias),
			...(problems.has(alias) ? { problem: problems.get(alias) } : {}),
		})),
	});

	const offBox = host.onBoxChange((alias, change) => {
		if (change === "held") {
			if (on()) void join(alias);
			return;
		}
		// Its connection is gone: the link stays, out of reach, until it is held again.
		leave(alias);
		problems.delete(alias);
		if (change === "forgotten") {
			links.drop(alias);
			attached.delete(alias);
		}
	});
	if (on()) void joinAll();

	return {
		status,
		async set(want) {
			updateSettings({ client: { macLink: want } });
			await (want ? joinAll() : leaveAll());
			return status();
		},
		dispose() {
			offBox();
			for (const alias of [...joined.keys()]) leave(alias);
		},
	};
}
