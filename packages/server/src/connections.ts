// Client-side connection manager: which remote hosts the user can drive an
// engine on, plus Ateam's own last-known metadata for each. Two kinds, both keyed
// by a single opaque alias:
//
//   ssh  an ~/.ssh/config alias. Connection details (hostname/port/keys/
//        jumphosts) stay OpenSSH's job — we only read the alias list.
//   ws   a `host:port` on the box's Tailscale address. There is no ssh_config to
//        defer to, so the endpoint IS the alias; nothing extra is stored.
//
// Lives in @ateam/server beside sshClientTransport (both are client primitives),
// and is deliberately NOT on AteamApi — managing connections is a client concern
// *about* choosing an engine, not something a remote engine serves.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AteamDb, type Host, repo } from "@ateam/db";
import type { ConnectionDTO, HostTransport } from "@ateam/protocol";

// ConnectionDTO is a client↔renderer boundary DTO — its home is @ateam/protocol;
// re-exported here so `listConnections`' callers keep importing it from the server.
export type { ConnectionDTO, HostTransport } from "@ateam/protocol";

/** A connectable destination parsed from ~/.ssh/config. */
export interface SshHost {
	alias: string;
	hostName: string | null;
	/** Explicit `Port`, if the stanza set one. null means OpenSSH's default (22). */
	port: string | null;
	/** Explicit `User`, if the stanza set one. Different user = different engine. */
	user: string | null;
}

/** What a successful connection learned about a host, to cache for offline render. */
export interface ConnectionRecord {
	hostAlias: string;
	transport?: HostTransport;
	serverVersion?: string | null;
	agentsAvailable?: string[] | null;
}

const DEFAULT_SSH_CONFIG = join(homedir(), ".ssh", "config");

/**
 * Is `target` a Tailscale endpoint (`host:port`) rather than an ssh_config alias?
 * Returns the `ws://` URL to dial, or null if it isn't one.
 *
 * The two namespaces don't collide in practice: OpenSSH `Host` patterns are
 * whitespace-delimited tokens and a colon has no meaning there, while an endpoint
 * must end in `:<port>`. IPv6 must be bracketed (`[100::1]:8787`) for the same
 * reason a URL requires it — otherwise the last colon is ambiguous.
 */
export function endpointUrl(target: string): string | null {
	const match = target.match(/^(\[[0-9a-fA-F:]+\]|[^:\s[\]]+):(\d{1,5})$/);
	if (!match?.[1] || !match[2]) return null;
	const port = Number(match[2]);
	if (port < 1 || port > 65535) return null;
	return `ws://${match[1]}:${port}`;
}

/**
 * How to open `target`: a saved row's transport wins; otherwise an ssh_config
 * alias is ssh, and anything shaped like an endpoint is ws. Deciding here rather
 * than at the call site keeps `connect(alias)` a single-argument operation for
 * every caller — the UI just passes what the user picked or typed.
 */
export function resolveTransport(
	db: AteamDb,
	target: string,
	configPath?: string,
): HostTransport | null {
	const saved = repo.getHost(db, target);
	if (saved) return saved.transport as HostTransport;
	if (readSshHosts(configPath).some((h) => h.alias === target)) return "ssh";
	return endpointUrl(target) ? "ws" : null;
}

/**
 * Parse `Host` aliases (and their HostName) from an ssh_config. Minimal by
 * design: OpenSSH resolves the full semantics at connect time — we only need the
 * connectable alias list for the picker.
 *
 * shortcut: reads one config file; no `Include` expansion, no `Match` blocks.
 * Add Include-following if users split their config across files.
 *
 * A stanza whose `Host` line contains ANY pattern (* ? !) is a defaults block —
 * it configures other destinations rather than being one — so none of its names
 * are offered, not even the literal ones sharing the line. That shape is common
 * (`Host *` with a User/IdentityFile) and boxd writes one verbatim:
 * `Host *.boxd *.boxd.sh boxd.sh`, where `boxd.sh` is not a machine. The cost is
 * that a line genuinely mixing a destination with patterns loses the destination;
 * that shape is rare, and mis-offering a non-destination is the worse failure.
 */
export function readSshHosts(configPath: string = DEFAULT_SSH_CONFIG): SshHost[] {
	let text: string;
	try {
		text = readFileSync(configPath, "utf8");
	} catch {
		return []; // no ssh config yet — nothing to offer
	}
	const out: SshHost[] = [];
	// Aliases of the stanza currently being parsed; a following HostName/Port applies
	// to all of them (`Host a b` shares options between a and b).
	let stanza: SshHost[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const match = line.match(/^(\S+)\s+(.+)$/);
		if (!match?.[1] || match[2] == null) continue;
		const key = match[1].toLowerCase();
		const value = match[2].trim();
		if (key === "host") {
			stanza = [];
			const aliases = value.split(/\s+/);
			if (aliases.some((a) => /[*?!]/.test(a))) continue; // defaults block, not a destination
			for (const alias of aliases) {
				const host: SshHost = { alias, hostName: null, port: null, user: null };
				out.push(host);
				stanza.push(host);
			}
		} else if (key === "hostname") {
			for (const host of stanza) host.hostName = value;
		} else if (key === "port") {
			for (const host of stanza) host.port = value;
		} else if (key === "user") {
			for (const host of stanza) host.user = value;
		}
	}
	return out;
}

/**
 * The engine an alias actually reaches, for collapsing aliases that are the same
 * box. Keyed on User+HostName+Port because that triple — not the name — decides
 * which daemon answers: boxd puts every machine behind ONE shared HostName and
 * separates them by port, so HostName alone would merge unrelated boxes; and two
 * users on one host have separate $HOME/.ateam databases, so they are separate
 * engines. Aliases with no HostName resolve as themselves, so they key on their
 * own name.
 */
function destinationKey(host: SshHost): string {
	const dest = (host.hostName ?? host.alias).toLowerCase();
	return `${host.user ?? ""}@${dest}:${host.port ?? "22"}`;
}

/**
 * The connections list: every ssh_config destination, enriched with our saved
 * metadata, plus any saved host whose alias has since left the config (so it can
 * still be seen/forgotten). Renders entirely from local state — no live SSH
 * connection.
 *
 * Aliases that dial the SAME destination collapse into one entry. This is not
 * cosmetic: `host.ts` keys its backends by alias, so connecting to a box twice
 * under two names opens two SSH children and two event subscriptions to one
 * daemon, and every engine event — PTY output included — arrives twice.
 */
export function listConnections(db: AteamDb, configPath?: string): ConnectionDTO[] {
	const saved = new Map(repo.listHosts(db).map((h) => [h.hostAlias, h]));
	const byAlias = new Map<string, ConnectionDTO>();
	// Every alias folded into a canonical entry — none may resurface below as a
	// "saved but no longer in the config" row, which would undo the collapse.
	const absorbed = new Set<string>();

	const groups = new Map<string, SshHost[]>();
	for (const sh of readSshHosts(configPath)) {
		const group = groups.get(destinationKey(sh));
		if (group) group.push(sh);
		else groups.set(destinationKey(sh), [sh]);
	}

	for (const group of groups.values()) {
		// Shortest name wins (`mybox.boxd` over `mybox.boxd.sh`); ties keep file order.
		const canonical = group.reduce((a, b) => (b.alias.length < a.alias.length ? b : a));
		// Metadata is keyed by alias, so a box previously reached under a now-folded
		// name still has its history — keep the most recently seen of them.
		let rec: Host | null = null;
		let hidden = false;
		for (const sh of group) {
			absorbed.add(sh.alias);
			const other = saved.get(sh.alias);
			if (other?.hidden) hidden = true;
			if (other && (other.lastSeen ?? 0) >= (rec?.lastSeen ?? 0)) rec = other;
		}
		// Removed from the list by the user; every alias stays absorbed so none of
		// the group's saved rows resurface in the saved-only loop below.
		if (hidden) continue;
		byAlias.set(canonical.alias, {
			alias: canonical.alias,
			// Everything folded here came out of ssh_config, so it is ssh by
			// construction; a ws endpoint has no stanza and appears in the saved loop.
			transport: "ssh",
			hostName: canonical.hostName,
			serverVersion: rec?.serverVersion ?? null,
			agentsAvailable: rec?.agentsAvailable ?? null,
			lastSeen: rec?.lastSeen ?? null,
			inSshConfig: true,
			known: rec != null,
		});
	}
	for (const rec of saved.values()) {
		if (absorbed.has(rec.hostAlias) || rec.hidden) continue;
		byAlias.set(rec.hostAlias, {
			alias: rec.hostAlias,
			transport: rec.transport as HostTransport,
			hostName: null,
			serverVersion: rec.serverVersion,
			agentsAvailable: rec.agentsAvailable,
			lastSeen: rec.lastSeen,
			inSshConfig: false,
			known: true,
		});
	}
	// Recently-reached first; never-connected (null lastSeen) after, ties by alias.
	return [...byAlias.values()].sort((a, b) => {
		if ((a.lastSeen ?? 0) !== (b.lastSeen ?? 0)) return (b.lastSeen ?? 0) - (a.lastSeen ?? 0);
		return a.alias.localeCompare(b.alias);
	});
}

/**
 * Record a successful connection: stamp lastSeen and cache whatever the box
 * reported. Only provided fields are written, so a bare touch never wipes a
 * previously-cached version/agent list.
 */
export function recordConnection(db: AteamDb, rec: ConnectionRecord): Host {
	const patch: Partial<Host> & { hostAlias: string } = {
		hostAlias: rec.hostAlias,
		lastSeen: Date.now(),
		// Reaching the box again is the way back in after a forget: setting it up (or
		// connecting to it) un-hides it, so removal is never a dead end.
		hidden: 0,
	};
	if (rec.transport !== undefined) patch.transport = rec.transport;
	if (rec.serverVersion !== undefined) patch.serverVersion = rec.serverVersion;
	if (rec.agentsAvailable !== undefined) patch.agentsAvailable = rec.agentsAvailable;
	return repo.upsertHost(db, patch);
}

/**
 * Remove a connection from the list. A row that exists only in our db (a ws
 * endpoint, or a user@host set up directly) is deleted outright; an alias still
 * in ~/.ssh/config would resurface on the next list, so it's flagged hidden
 * instead — ssh_config stays OpenSSH's file, we never edit it. Either way,
 * connecting to (or setting up) the box again brings it back: recordConnection
 * clears the flag.
 */
export function forgetConnection(db: AteamDb, alias: string, configPath?: string): void {
	if (readSshHosts(configPath).some((h) => h.alias === alias)) {
		repo.upsertHost(db, { hostAlias: alias, hidden: 1 });
	} else {
		repo.deleteHost(db, alias);
	}
}
