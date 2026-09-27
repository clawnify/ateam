// Secrets the engine needs, kept apart from settings.
//
// `settings.json` is built to be shared: its header invites you to sync it with
// your dotfiles, and `settings:get` hands the whole file to every client, the
// phone included. A key belongs in neither place. So it lives next to it in
// `credentials.json`, mode 0600, on the machine whose engine uses it — the
// split Codex (`~/.codex/auth.json`) and OpenCode (`auth.json`) already make.
//
// The wire only ever carries whether a key is set and its last four characters
// (`credentialStatus`). The key itself leaves this module only to be sent to
// the service it belongs to, or to a box of yours by the settings sync.
//
// An environment variable wins over the file, as it does for every CLI that
// reads OPENROUTER_API_KEY, so a key set in your login shell just works.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CredentialStatus, CredentialsPatch } from "@ateam/protocol";
import { settingsPath } from "./settings-file";

interface CredentialsFile {
	openRouterApiKey?: string;
}

/** Beside settings.json, so `ATEAM_CONFIG` moves both. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(dirname(settingsPath(env)), "credentials.json");
}

function readFile(path: string): CredentialsFile {
	if (!existsSync(path)) return {};
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as CredentialsFile) : {};
	} catch {
		// Unreadable is "no key": every feature behind a key already has a
		// keyless path, and the next save rewrites the file whole.
		return {};
	}
}

/** The OpenRouter key in force, or undefined. Read per use, so an edit applies at once. */
export function openRouterApiKey(
	path: string = credentialsPath(),
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return env.OPENROUTER_API_KEY?.trim() || readFile(path).openRouterApiKey?.trim() || undefined;
}

export function credentialStatus(
	path: string = credentialsPath(),
	env: NodeJS.ProcessEnv = process.env,
): CredentialStatus {
	const fromEnv = env.OPENROUTER_API_KEY?.trim();
	const key = fromEnv || readFile(path).openRouterApiKey?.trim();
	if (!key) return { set: false };
	return { set: true, hint: key.slice(-4), source: fromEnv ? "env" : "file" };
}

/**
 * Store or remove keys. Atomic (tmp + rename) and 0600 from the first byte:
 * the tmp file is created with the mode, so there is no window in which the
 * key sits world-readable.
 */
export function updateCredentials(patch: CredentialsPatch, path: string = credentialsPath()): void {
	const next = readFile(path);
	if (patch.openRouterApiKey !== undefined) {
		const key = patch.openRouterApiKey?.trim();
		if (key) next.openRouterApiKey = key;
		else delete next.openRouterApiKey;
	}
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	// writeFileSync's mode applies only when it creates the file; a leftover
	// tmp from a crash keeps whatever it had.
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}
