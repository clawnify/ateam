// Client-side connection manager: which remote hosts the user can drive an
// engine on, plus Ateam's own last-known metadata for each. Connection details
// (hostname/port/keys/jumphosts) stay in ~/.ssh/config — OpenSSH's job; we only
// read the alias list from it and persist our metadata keyed by alias. Lives in
// @ateam/server beside sshClientTransport (both are client primitives), and is
// deliberately NOT on AteamApi — managing connections is a client concern *about*
// choosing an engine, not something a remote engine serves.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AteamDb, type Host, repo } from "@ateam/db";

/** A connectable destination parsed from ~/.ssh/config. */
export interface SshHost {
	alias: string;
	hostName: string | null;
}

/** A row in the connections list: ssh_config presence merged with our metadata. */
export interface ConnectionDTO {
	alias: string;
	hostName: string | null;
	serverVersion: string | null;
	agentsAvailable: string[] | null;
	lastSeen: number | null;
	/** Present in ~/.ssh/config right now (vs a saved record since removed from it). */
	inSshConfig: boolean;
	/** We've recorded at least one successful connection (has a saved record). */
	known: boolean;
}

/** What a successful connection learned about a host, to cache for offline render. */
export interface ConnectionRecord {
	hostAlias: string;
	serverVersion?: string | null;
	agentsAvailable?: string[] | null;
}

const DEFAULT_SSH_CONFIG = join(homedir(), ".ssh", "config");

/**
 * Parse `Host` aliases (and their HostName) from an ssh_config. Minimal by
 * design: OpenSSH resolves the full semantics at connect time — we only need the
 * connectable alias list for the picker.
 *
 * shortcut: reads one config file; no `Include` expansion, no `Match` blocks.
 * Pattern aliases (containing * ? !) are skipped — they're templates, not
 * destinations. Add Include-following if users split their config across files.
 */
export function readSshHosts(configPath: string = DEFAULT_SSH_CONFIG): SshHost[] {
	let text: string;
	try {
		text = readFileSync(configPath, "utf8");
	} catch {
		return []; // no ssh config yet — nothing to offer
	}
	const out: SshHost[] = [];
	// Aliases of the stanza currently being parsed; a following HostName applies
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
			for (const alias of value.split(/\s+/)) {
				if (/[*?!]/.test(alias)) continue; // pattern, not a destination
				const host: SshHost = { alias, hostName: null };
				out.push(host);
				stanza.push(host);
			}
		} else if (key === "hostname") {
			for (const host of stanza) host.hostName = value;
		}
	}
	return out;
}

/**
 * The connections list: every ssh_config host, enriched with our saved metadata,
 * plus any saved host whose alias has since left the config (so it can still be
 * seen/forgotten). Renders entirely from local state — no live SSH connection.
 */
export function listConnections(db: AteamDb, configPath?: string): ConnectionDTO[] {
	const saved = new Map(repo.listHosts(db).map((h) => [h.hostAlias, h]));
	const byAlias = new Map<string, ConnectionDTO>();

	for (const sh of readSshHosts(configPath)) {
		const rec = saved.get(sh.alias);
		byAlias.set(sh.alias, {
			alias: sh.alias,
			hostName: sh.hostName,
			serverVersion: rec?.serverVersion ?? null,
			agentsAvailable: rec?.agentsAvailable ?? null,
			lastSeen: rec?.lastSeen ?? null,
			inSshConfig: true,
			known: rec != null,
		});
	}
	for (const rec of saved.values()) {
		if (byAlias.has(rec.hostAlias)) continue;
		byAlias.set(rec.hostAlias, {
			alias: rec.hostAlias,
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
	};
	if (rec.serverVersion !== undefined) patch.serverVersion = rec.serverVersion;
	if (rec.agentsAvailable !== undefined) patch.agentsAvailable = rec.agentsAvailable;
	return repo.upsertHost(db, patch);
}
