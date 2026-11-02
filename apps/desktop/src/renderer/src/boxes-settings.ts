// Settings → Boxes, as data: one row per box this Mac has used, from what the
// desktop already knows without connecting (its connection records and the
// engines it holds). Nothing here reaches a box, so listing never wakes one.

import { type ConnectionDTO, providerById, wakeMachineName } from "@ateam/protocol";
import type { HostStatus } from "../../shared/host";

export interface BoxRow {
	/** The connection alias every host call takes. */
	alias: string;
	/** What the box is called: its machine name at a provider, else the alias. */
	title: string;
	/** How it's reached, and through which provider. */
	detail: string;
	transport: "ssh" | "ws";
	state: "connected" | "asleep" | "offline";
	/** The engine's protocol version: the live one when held, the last seen otherwise. */
	version: number | null;
	/** Against this app's protocol. */
	engine: "current" | "behind" | "ahead" | "unknown";
	lastSeen: number | null;
	/** Why the app's own last attempt to connect failed, if it did. */
	failure: string | null;
}

const ORDER = { connected: 0, asleep: 1, offline: 2 } as const;

/**
 * The boxes to list: every one this Mac has connected to before. SSH hosts that
 * never ran Ateam stay out, however many ~/.ssh/config lists. Connected first,
 * then asleep, then the rest, each most recently seen first.
 */
export function boxRows(
	connections: readonly ConnectionDTO[],
	held: readonly HostStatus[],
	failures: Readonly<Record<string, string>>,
	protocol: number,
): BoxRow[] {
	const live = new Map(held.flatMap((h) => (h.alias ? [[h.alias, h.info.protocolVersion]] : [])));
	return connections
		.filter((c) => c.known)
		.map((c): BoxRow => {
			const liveVersion = live.get(c.alias);
			const seen = Number(c.serverVersion);
			const version = liveVersion ?? (Number.isFinite(seen) && seen > 0 ? seen : null);
			const provider = c.wake ? providerById(c.wake.id)?.label : undefined;
			const reach = c.transport === "ws" ? `Tailscale ${c.alias}` : `SSH ${c.hostName ?? c.alias}`;
			return {
				alias: c.alias,
				title: wakeMachineName(c.wake) ?? c.alias,
				detail: provider ? `${provider} · ${reach}` : reach,
				transport: c.transport === "ws" ? "ws" : "ssh",
				state: liveVersion !== undefined ? "connected" : c.asleep ? "asleep" : "offline",
				version,
				engine:
					version == null
						? "unknown"
						: version < protocol
							? "behind"
							: version > protocol
								? "ahead"
								: "current",
				lastSeen: c.lastSeen,
				failure: failures[c.alias] ?? null,
			};
		})
		.sort((a, b) => ORDER[a.state] - ORDER[b.state] || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
}

/** The engine half of a row's status line. */
export function engineLabel(row: BoxRow): string {
	switch (row.engine) {
		case "current":
			return `engine v${row.version}, up to date`;
		case "behind":
			return `engine v${row.version}, update available`;
		case "ahead":
			return `engine v${row.version}, newer than this app`;
		default:
			return "engine version unknown";
	}
}
