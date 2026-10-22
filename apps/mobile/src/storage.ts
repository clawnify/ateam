// Persist the last connection so the host/port survive app restarts and
// reinstalls — otherwise every launch (and every rebuild) starts blank and you
// retype the box's Tailscale IP. AsyncStorage is RN's simple key-value store.
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

const KEY = "ateam.connection";
const PROJECT_KEY = "ateam.selectedProject";
const PREVIEW_PORT_KEY = "ateam.previewPort";

export interface SavedConnection {
	host: string;
	port: string;
	/** The provider the phone wakes this box through before connecting, with this
	 *  box's own inputs (its machine name). The account inputs live in the Keychain. */
	provider?: { id: string; box: Record<string, string> };
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

// A provider's account inputs (its API key), what the phone wakes a sleeping box
// with. In the iOS Keychain, never AsyncStorage: a provider key can usually act on
// far more than one box. One set per provider, shared by every box there; which box
// to wake rides on the connection.
const accountItem = (providerId: string, key: string) => `ateam.provider.${providerId}.${key}`;

export async function loadProviderAccount(
	providerId: string,
	keys: string[],
): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const key of keys) {
		try {
			const value = await SecureStore.getItemAsync(accountItem(providerId, key));
			if (value) out[key] = value;
		} catch {
			/* unreadable reads as unset: the field just asks again */
		}
	}
	return out;
}

/** Save one account input, or remove it with null. Throws: a value that didn't save must not look saved. */
export async function saveProviderAccount(
	providerId: string,
	key: string,
	value: string | null,
): Promise<void> {
	if (value) await SecureStore.setItemAsync(accountItem(providerId, key), value);
	else await SecureStore.deleteItemAsync(accountItem(providerId, key));
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
