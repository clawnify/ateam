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
import type { ConnectionDTO, HostTransport } from "@ateam/protocol";
import { type AteamDb, type Host, repo } from "@ateam/db";

// ConnectionDTO is a client↔renderer boundary DTO — its home is @ateam/protocol;
// re-exported here so `listConnections`' callers keep importing it from the server.
export type { ConnectionDTO, HostTransport } from "@ateam/protocol";

/** A connectable destination parsed from ~/.ssh/config. */
export interface SshHost {
	alias: string;
	hostName: string | null;
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
			transport: "ssh",
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
	};
	if (rec.transport !== undefined) patch.transport = rec.transport;
	if (rec.serverVersion !== undefined) patch.serverVersion = rec.serverVersion;
	if (rec.agentsAvailable !== undefined) patch.agentsAvailable = rec.agentsAvailable;
	return repo.upsertHost(db, patch);
}
