// The Electron-side helpers for creating a box from scratch: encrypted secret
// storage (provider token + Tailscale auth key), an app-owned SSH key the user never
// sees, a ~/.ssh/config entry so every later connect resolves the box + key
// transparently, and readiness polls between "server created" and "installable". The
// provider API + cloud-init are in @ateam/server (pure); this is the machine glue.

import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sshExec } from "@ateam/server";
import { safeStorage } from "electron";

/** The provider credentials, kept encrypted at rest (never in the renderer). */
export interface ProviderSecrets {
	hetznerToken?: string;
	tailscaleAuthKey?: string;
}

/**
 * A tiny encrypted key/value for the two provisioning secrets. Uses the OS keychain
 * via Electron safeStorage; if the platform has no encryption backend, secrets are
 * held in memory for the session only — never written to disk in plaintext.
 */
export function createSecretStore(filePath: string) {
	const canPersist = safeStorage.isEncryptionAvailable();
	let memory: ProviderSecrets = {};

	const load = (): ProviderSecrets => {
		if (!canPersist) return memory;
		try {
			return JSON.parse(safeStorage.decryptString(readFileSync(filePath))) as ProviderSecrets;
		} catch {
			return {};
		}
	};
	const save = (patch: ProviderSecrets): ProviderSecrets => {
		const next: ProviderSecrets = { ...load(), ...patch };
		for (const k of Object.keys(next) as (keyof ProviderSecrets)[]) if (!next[k]) delete next[k];
		if (!canPersist) {
			memory = next;
			return next;
		}
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, safeStorage.encryptString(JSON.stringify(next)), { mode: 0o600 });
		return next;
	};
	return { load, save };
}

/**
 * Generate a fresh ed25519 keypair for a box via `ssh-keygen` (always present on the
 * user's machine — avoids hand-encoding the OpenSSH wire format). The private key
 * stays on the Mac (0600); the public key is authorized on the box. The user never
 * sees or manages it — this is what dissolves the "make an SSH key" friction.
 */
export function generateBoxKey(
	userDataDir: string,
	alias: string,
): { publicKey: string; privateKeyPath: string } {
	const privateKeyPath = join(userDataDir, "box-keys", `${alias}.key`);
	mkdirSync(dirname(privateKeyPath), { recursive: true });
	// ssh-keygen refuses to overwrite; clear any stale key from a prior attempt.
	rmSync(privateKeyPath, { force: true });
	rmSync(`${privateKeyPath}.pub`, { force: true });
	const r = spawnSync(
		"ssh-keygen",
		["-t", "ed25519", "-N", "", "-C", `ateam-${alias}`, "-f", privateKeyPath],
		{
			encoding: "utf8",
		},
	);
	if (r.status !== 0) throw new Error(`ssh-keygen failed: ${(r.stderr || r.stdout || "").trim()}`);
	chmodSync(privateKeyPath, 0o600);
	return { publicKey: readFileSync(`${privateKeyPath}.pub`, "utf8").trim(), privateKeyPath };
}

/**
 * Append a `Host <alias>` block to ~/.ssh/config so connect() (and the installer)
 * reach the box with the app-owned key, no agent juggling. `accept-new` auto-trusts
 * the brand-new box's host key (a prompt would hang the non-interactive `ssh`).
 *
 * Returns the alias actually used. Critically, it NEVER hijacks or skips a user's
 * existing alias: if `<alias>` already belongs to a different Host (e.g. the user has
 * their own `Host hetzner`), it suffixes `-2`, `-3`, … until free — otherwise we'd
 * silently SSH to the wrong machine. Re-running for the same box (our marker + same
 * HostName) is a no-op.
 */
export function writeSshConfigEntry(alias: string, hostName: string, identityFile: string): string {
	const cfgPath = join(homedir(), ".ssh", "config");
	let existing = "";
	try {
		existing = readFileSync(cfgPath, "utf8");
	} catch {
		mkdirSync(dirname(cfgPath), { recursive: true, mode: 0o700 });
	}
	const hasHost = (a: string) => new RegExp(`^Host\\s+${a}(?:\\s|$)`, "m").test(existing);
	const oursForThisBox = (a: string) => {
		const m = existing.match(
			new RegExp(`# ateam-managed box "${a}"[\\s\\S]*?HostName\\s+(\\S+)`, "m"),
		);
		return m?.[1] === hostName;
	};

	let used = alias;
	if (hasHost(used) && !oursForThisBox(used)) {
		let n = 2;
		while (hasHost(`${alias}-${n}`) && !oursForThisBox(`${alias}-${n}`)) n++;
		used = `${alias}-${n}`;
	}
	if (oursForThisBox(used)) return used; // already written for this box

	const block = [
		"",
		`# ateam-managed box "${used}"`,
		`Host ${used}`,
		`    HostName ${hostName}`,
		"    User ateam",
		`    IdentityFile ${identityFile}`,
		"    StrictHostKeyChecking accept-new",
		"",
	].join("\n");
	appendFileSync(cfgPath, block, { mode: 0o600 });
	return used;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `ssh ateam@<box>` succeeds — i.e. cloud-init made the user and sshd is up. */
export async function waitForSsh(alias: string, tries = 36, everyMs = 5000): Promise<void> {
	for (let i = 0; i < tries; i++) {
		const r = await sshExec(alias, "true");
		if (r.code === 0) return;
		await sleep(everyMs);
	}
	throw new Error(`"${alias}" never became reachable over SSH`);
}

/**
 * Poll until Tailscale has an IPv4 on the box (so the installer can bake ATEAM_WS_ADDR
 * for the phone). Returns false on timeout rather than throwing — a box with no phone
 * listener is still a usable desktop box, so the caller installs anyway and warns.
 */
export async function waitForTailscale(
	alias: string,
	tries = 30,
	everyMs = 5000,
): Promise<boolean> {
	for (let i = 0; i < tries; i++) {
		let out = "";
		const r = await sshExec(alias, "tailscale ip -4 2>/dev/null || true", {
			onData: (c) => {
				out += c;
			},
		});
		if (r.code === 0 && /\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(out)) return true;
		await sleep(everyMs);
	}
	return false;
}
