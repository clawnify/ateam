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
// For OpenRouter an environment variable wins over the file, as it does for
// every CLI that reads OPENROUTER_API_KEY, so a key set in your login shell just
// works. Not for OpenAI: OPENAI_API_KEY is what Codex and most other tools read,
// and setting it for them is no choice to send your prompts to OpenAI from
// Ateam, so only a key saved here counts.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CredentialStatus, CredentialsPatch, CredentialsResult } from "@ateam/protocol";
import { settingsPath } from "./settings-file";

interface CredentialsFile {
	openRouterApiKey?: string;
	openAiApiKey?: string;
}

/** The keys a patch may set, each a field of both the patch and the file. */
const KEY_FIELDS = ["openRouterApiKey", "openAiApiKey"] as const;

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

/** The OpenAI key saved here, or undefined. The file only (see the header). */
export function openAiApiKey(path: string = credentialsPath()): string | undefined {
	return readFile(path).openAiApiKey?.trim() || undefined;
}

function status(key: string | undefined, source: "file" | "env"): CredentialStatus {
	return key ? { set: true, hint: key.slice(-4), source } : { set: false };
}

/** Each key's status, never the key: what the wire may carry. */
export function credentialStatuses(
	path: string = credentialsPath(),
	env: NodeJS.ProcessEnv = process.env,
): Pick<CredentialsResult, "openRouter" | "openAi"> {
	const file = readFile(path);
	const fromEnv = env.OPENROUTER_API_KEY?.trim();
	return {
		openRouter: status(fromEnv || file.openRouterApiKey?.trim(), fromEnv ? "env" : "file"),
		openAi: status(file.openAiApiKey?.trim(), "file"),
	};
}

/**
 * Store or remove keys. Atomic (tmp + rename) and 0600 from the first byte:
 * the tmp file is created with the mode, so there is no window in which the
 * key sits world-readable.
 */
export function updateCredentials(patch: CredentialsPatch, path: string = credentialsPath()): void {
	const next = readFile(path);
	for (const field of KEY_FIELDS) {
		if (patch[field] === undefined) continue;
		const key = patch[field]?.trim();
		if (key) next[field] = key;
		else delete next[field];
	}
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	// writeFileSync's mode applies only when it creates the file; a leftover
	// tmp from a crash keeps whatever it had.
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}
