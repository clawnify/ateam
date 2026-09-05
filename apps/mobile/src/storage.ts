// Persist the last connection so the host/port survive app restarts and
// reinstalls — otherwise every launch (and every rebuild) starts blank and you
// retype the box's Tailscale IP. AsyncStorage is RN's simple key-value store.
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "ateam.connection";
const PROJECT_KEY = "ateam.selectedProject";
const PREVIEW_PORT_KEY = "ateam.previewPort";

export interface SavedConnection {
	host: string;
	port: string;
}

export async function loadConnection(): Promise<SavedConnection | null> {
	try {
		const raw = await AsyncStorage.getItem(KEY);
		return raw ? (JSON.parse(raw) as SavedConnection) : null;
	} catch {
		return null;
	}
}

export async function saveConnection(conn: SavedConnection): Promise<void> {
	try {
		await AsyncStorage.setItem(KEY, JSON.stringify(conn));
	} catch {
		/* best-effort — a failed persist just means a blank field next launch */
	}
}

/** Remember the last-picked project so reopening the app lands on it, not project #1. */
export async function loadSelectedProject(): Promise<string | null> {
	try {
		return await AsyncStorage.getItem(PROJECT_KEY);
	} catch {
		return null;
	}
}

export async function saveSelectedProject(id: string): Promise<void> {
	try {
		await AsyncStorage.setItem(PROJECT_KEY, id);
	} catch {
		/* best-effort — a failed persist just falls back to the first project */
	}
}

/** Remember the dev-server port used for the on-box preview (defaults to 3000). */
export async function loadPreviewPort(): Promise<string | null> {
	try {
		return await AsyncStorage.getItem(PREVIEW_PORT_KEY);
	} catch {
		return null;
	}
}

export async function savePreviewPort(port: string): Promise<void> {
	try {
		await AsyncStorage.setItem(PREVIEW_PORT_KEY, port);
	} catch {
		/* best-effort — a failed persist just falls back to the default port */
	}
}

// The privacy disclosure the user accepted, stored as the policy's effective date
// rather than a boolean: if PRIVACY.md materially changes, bump CONSENT_VERSION and
// everyone is asked again instead of being silently carried over on an old consent.
const CONSENT_KEY = "ateam.privacyConsent";
export const CONSENT_VERSION = "2026-08-20";

/** True only if this exact disclosure version was accepted. */
export async function loadConsent(): Promise<boolean> {
	try {
		return (await AsyncStorage.getItem(CONSENT_KEY)) === CONSENT_VERSION;
	} catch {
		return false;
	}
}

export async function saveConsent(): Promise<void> {
	try {
		await AsyncStorage.setItem(CONSENT_KEY, CONSENT_VERSION);
	} catch {
		/* best-effort: a failed persist just asks again next launch, never less safe */
	}
}

// The box version whose "older Ateam" banner the user dismissed, per box. The
// banner returns on its own when the box reports a different version.
const skewKey = (host: string) => `ateam.skewDismissed.${host}`;

export async function loadDismissedSkew(host: string): Promise<number | null> {
	try {
		const v = await AsyncStorage.getItem(skewKey(host));
		return v === null ? null : Number(v);
	} catch {
		return null;
	}
}

export async function saveDismissedSkew(host: string, version: number): Promise<void> {
	try {
		await AsyncStorage.setItem(skewKey(host), String(version));
	} catch {
		/* best-effort — the banner just shows again next launch */
	}
}
