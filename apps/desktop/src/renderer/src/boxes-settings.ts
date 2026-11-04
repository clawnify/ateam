// Settings → Boxes, as data: one row per box this Mac has used, from what the
// desktop already knows without connecting (its connection records and the
// engines it holds). Nothing here reaches a box, so listing never wakes one.

import {
	type ConnectionDTO,
	FEATURE_MIN_VERSION,
	type GithubAccessDTO,
	githubTokenNeedsRenewal,
	providerById,
	wakeMachineName,
} from "@ateam/protocol";
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
	/** The release the engine was built from, live or last seen; null when it didn't say. */
	release: string | null;
	/** Against this app: its protocol first, then its release. */
	engine: "current" | "behind" | "ahead" | "unknown";
	/** It speaks the protocol GitHub access needs, so its GitHub panel works. */
	githubReady: boolean;
	/** Its engine has a Lead of its own (v24), so the desktop's can live there. */
	leadReady: boolean;
	/** Its engine can be locked to paired devices (v29). */
	pairingReady: boolean;
	/** Where its network port listens (`<host>:<port>`), which Ateam Go and other
	 *  boxes connect to; null when it has none, so only SSH reaches it. Absent when
	 *  not known: not connected, or an engine from before it said (v30). */
	networkPort?: string | null;
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
	app: { protocol: number; release: string },
): BoxRow[] {
	const live = new Map(held.flatMap((h) => (h.alias ? [[h.alias, h.info] as const] : [])));
	return connections
		.filter((c) => c.known)
		.map((c): BoxRow => {
			const info = live.get(c.alias);
			const seen = Number(c.serverVersion);
			const version = info?.protocolVersion ?? (Number.isFinite(seen) && seen > 0 ? seen : null);
			const release = (info ? info.release : c.engineRelease) ?? null;
			const provider = c.wake ? providerById(c.wake.id)?.label : undefined;
			const reach = c.transport === "ws" ? `Tailscale ${c.alias}` : `SSH ${c.hostName ?? c.alias}`;
			return {
				alias: c.alias,
				title: wakeMachineName(c.wake) ?? c.alias,
				detail: provider ? `${provider} · ${reach}` : reach,
				transport: c.transport === "ws" ? "ws" : "ssh",
				state: info ? "connected" : c.asleep ? "asleep" : "offline",
				version,
				release,
				engine: engineAgainst(version, release, app),
				githubReady: version != null && version >= FEATURE_MIN_VERSION.githubAccess,
				leadReady: version != null && version >= FEATURE_MIN_VERSION.lead,
				pairingReady: version != null && version >= FEATURE_MIN_VERSION.pairing,
				...(info && info.wsAddr !== undefined ? { networkPort: info.wsAddr } : {}),
				lastSeen: c.lastSeen,
				failure: failures[c.alias] ?? null,
			};
		})
		.sort((a, b) => ORDER[a.state] - ORDER[b.state] || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
}

/**
 * A box's engine against this app. The protocol decides first. On the same protocol
 * the release does, since a release can change the engine without bumping it. An
 * engine that names no release predates reporting one, so it's older than this app.
 */
function engineAgainst(
	version: number | null,
	release: string | null,
	app: { protocol: number; release: string },
): BoxRow["engine"] {
	if (version == null) return "unknown";
	if (version !== app.protocol) return version < app.protocol ? "behind" : "ahead";
	if (release == null) return "behind";
	const order = compareReleases(release, app.release);
	return order < 0 ? "behind" : order > 0 ? "ahead" : "current";
}

/** Orders two releases ("0.1.79" before "0.1.80"): negative, zero or positive. */
export function compareReleases(a: string, b: string): number {
	const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/**
 * The connected boxes that need you: an engine behind this app (its Update fixes
 * that), or a GitHub token close to expiring or refused. Connected ones only, so a
 * box not reached in months can't hold a dot up for good.
 */
export function boxesNeedingYou(
	rows: readonly BoxRow[],
	github: Readonly<Record<string, GithubAccessDTO>>,
	now: number,
): Set<string> {
	const needs = (r: BoxRow) => {
		const access = github[r.alias];
		return r.engine === "behind" || (access != null && githubTokenNeedsRenewal(access, now));
	};
	return new Set(rows.filter((r) => r.state === "connected" && needs(r)).map((r) => r.alias));
}

/** The engine half of a row's status line. */
export function engineLabel(row: BoxRow): string {
	const name = row.release ?? `v${row.version}`;
	switch (row.engine) {
		case "current":
			return `engine ${name}, up to date`;
		case "behind":
			return `engine ${name}, update available`;
		case "ahead":
			return `engine ${name}, newer than this app`;
		default:
			return "engine version unknown";
	}
}
