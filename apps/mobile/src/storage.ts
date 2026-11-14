// Persist the boxes the phone has connected to, so they survive app restarts and
// reinstalls. Otherwise every launch (and every rebuild) starts blank and you
// retype the box's Tailscale IP. AsyncStorage is RN's simple key-value store.
import { asSnapshot, type BoxSnapshot } from "@ateam/protocol";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { parseBoxes, type SavedBox } from "./boxes";
import { type GithubSeen, NO_GITHUB_SEEN, parseGithubSeen } from "./github-seen";

// The one connection kept before the Boxes list existed: read once, to migrate it.
const KEY = "ateam.connection";
const BOXES_KEY = "ateam.boxes";
const PROJECT_KEY = "ateam.selectedProject";
const SIDEBAR_COLLAPSED_KEY = "ateam.sidebarCollapsed";
const COMPOSER_TARGET_KEY = "ateam.composerTarget";
const PREVIEW_PORT_KEY = "ateam.previewPort";
const GITHUB_SEEN_KEY = "ateam.githubSeen";
const CALL_NOTICE_KEY = "ateam.callNotice";

/** Whether the user has read what a call sends to OpenAI, told once before the first call. */
export async function loadCallNotice(): Promise<boolean> {
	try {
		return (await AsyncStorage.getItem(CALL_NOTICE_KEY)) === "1";
	} catch {
		return false;
	}
}

export async function saveCallNotice(): Promise<void> {
	try {
		await AsyncStorage.setItem(CALL_NOTICE_KEY, "1");
	} catch {
		/* best-effort: the notice shows again before the next call */
	}
}

// The connection log (src/conn-log.ts) as it stood, so a restart doesn't lose it.
const CONN_LOG_KEY = "ateam.connLog";

export async function loadConnLog(): Promise<string | null> {
	try {
		return await AsyncStorage.getItem(CONN_LOG_KEY);
	} catch {
		return null;
	}
}

export async function saveConnLog(raw: string): Promise<void> {
	try {
		await AsyncStorage.setItem(CONN_LOG_KEY, raw);
	} catch {
		// The log is a diagnostic: failing to keep it costs nothing else.
	}
}

export interface SavedConnection {
	host: string;
	port: string;
	/** Absent for existing WebSocket/tailnet boxes. Private credentials live only
	 * in the native device Keychain; hostKey is the explicitly trusted public key. */
	ssh?: { user: string; identity: string; auth: "key" | "password"; hostKey?: string };
	/** Recovery handle retained as soon as a server starts billing. */
	createdServer?: { provider: "hetzner"; id: string };
	/** The provider the phone wakes this box through before connecting, with this
	 *  box's own inputs (its machine name). The account inputs live in the Keychain. */
	provider?: { id: string; box: Record<string, string> };
	/** Whether the box last said it sleeps when idle (SystemInfo.provider.sleeps);
	 *  false while it's always on. The box's own fact, so every report replaces it.
	 *  Absent until a box says, and the phone then goes by its provider. */
	sleeps?: boolean;
}

/** Every box the phone has connected to, newest first (src/boxes.ts). Before the
 *  list existed only the last connection was kept, and that becomes its first box. */
export async function loadBoxes(): Promise<SavedBox[]> {
	try {
		const [list, last] = await Promise.all([
			AsyncStorage.getItem(BOXES_KEY),
			AsyncStorage.getItem(KEY),
		]);
		return parseBoxes(list, last);
	} catch {
		return [];
	}
}

/** Whether the list reached storage (a required save throws instead of saying no). */
export async function saveBoxes(boxes: SavedBox[], required = false): Promise<boolean> {
	try {
		await AsyncStorage.setItem(BOXES_KEY, JSON.stringify(boxes));
		return true;
	} catch {
		if (required)
			throw new Error(
				"Could not save the box on this phone. Free storage before continuing setup.",
			);
		/* Other callers retain the current in-memory list. */
		return false;
	}
}

// Each box's board as the phone last saw it (src/fleet.ts), so a box that is
// asleep when the app opens still lists its projects and tasks.
const boardKey = (box: string) => `ateam.board.${box}`;

/** Every saved box's last-seen board that parses; a box without one is left out. */
export async function loadBoards(boxes: string[]): Promise<Map<string, BoxSnapshot>> {
	const out = new Map<string, BoxSnapshot>();
	await Promise.all(
		boxes.map(async (box) => {
			try {
				const raw = await AsyncStorage.getItem(boardKey(box));
				const snap = asSnapshot(raw ? JSON.parse(raw) : null);
				if (snap) out.set(box, snap);
			} catch {
				/* unreadable reads as none: the box's cards wait for it to answer */
			}
		}),
	);
	return out;
}

export async function saveBoard(box: string, snapshot: BoxSnapshot): Promise<void> {
	try {
		await AsyncStorage.setItem(boardKey(box), JSON.stringify(snapshot));
	} catch {
		/* best-effort: next launch shows the board kept before this one */
	}
}

export async function removeBoard(box: string): Promise<void> {
	try {
		await AsyncStorage.removeItem(boardKey(box));
	} catch {
		/* best-effort: a removed box's board is never read again anyway */
	}
}

// The box whose Lead the corner button and the composer's Lead talk to, picked
// in Boxes. Each box runs its own Lead, which sees that box's tasks only.
const LEAD_BOX_KEY = "ateam.leadBox";

export async function loadLeadBox(): Promise<string | null> {
	try {
		return await AsyncStorage.getItem(LEAD_BOX_KEY);
	} catch {
		return null;
	}
}

export async function saveLeadBox(box: string): Promise<void> {
	try {
		await AsyncStorage.setItem(LEAD_BOX_KEY, box);
	} catch {
		/* best-effort: the Lead falls back to the box used last */
	}
}

// The box a new task runs on when its project is on more than one (the
// composer's Run on), kept like the desktop's `ateam.runOn`.
const RUN_ON_KEY = "ateam.runOn";

export async function loadRunOn(): Promise<string | null> {
	try {
		return await AsyncStorage.getItem(RUN_ON_KEY);
	} catch {
		return null;
	}
}

export async function saveRunOn(box: string): Promise<void> {
	try {
		await AsyncStorage.setItem(RUN_ON_KEY, box);
	} catch {
		/* best-effort: Run on starts on the project's first box next time */
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

/** Where the board's composer sends: a new task, or the box's Lead chat. */
export type ComposerTarget = "task" | "lead";

/** The composer's last choice; a task when none was saved. */
export async function loadComposerTarget(): Promise<ComposerTarget> {
	try {
		return (await AsyncStorage.getItem(COMPOSER_TARGET_KEY)) === "lead" ? "lead" : "task";
	} catch {
		return "task";
	}
}

export async function saveComposerTarget(target: ComposerTarget): Promise<void> {
	try {
		await AsyncStorage.setItem(COMPOSER_TARGET_KEY, target);
	} catch {
		/* best-effort: it starts on Task next time */
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

// This phone's device token for each locked box it is paired with (pairing,
// protocol v29), by box key. In the Keychain: it is the phone's key to the box.
const tokenItem = (key: string) => `ateam.boxtoken.${key.replace(/[^A-Za-z0-9._-]/g, "_")}`;

export async function loadBoxToken(key: string): Promise<string | undefined> {
	try {
		return (await SecureStore.getItemAsync(tokenItem(key))) ?? undefined;
	} catch {
		return undefined;
	}
}

/** Keep a box's token, or forget it with null. Throws, so a token that didn't save never looks saved. */
export async function saveBoxToken(key: string, token: string | null): Promise<void> {
	if (token) await SecureStore.setItemAsync(tokenItem(key), token);
	else await SecureStore.deleteItemAsync(tokenItem(key));
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

// When the box's Lead chat was last on screen, per box: the newest item's time
// then (the box's clock). The dot on the Lead button is for anything newer.
const leadSeenKey = (box: string) => `ateam.leadSeen.${box}`;

/** null when nothing was kept for this box yet. */
export async function loadLeadSeen(box: string): Promise<number | null> {
	try {
		const v = await AsyncStorage.getItem(leadSeenKey(box));
		return v === null || !Number.isFinite(Number(v)) ? null : Number(v);
	} catch {
		return null;
	}
}

export async function saveLeadSeen(box: string, at: number): Promise<void> {
	try {
		await AsyncStorage.setItem(leadSeenKey(box), String(at));
	} catch {
		/* best-effort: the dot may show for something already read, next launch */
	}
}

/** The GitHub accounts the phone has seen on any box (src/github-seen.ts). */
export async function loadGithubSeen(): Promise<GithubSeen> {
	try {
		return parseGithubSeen(await AsyncStorage.getItem(GITHUB_SEEN_KEY));
	} catch {
		return NO_GITHUB_SEEN;
	}
}

export async function saveGithubSeen(seen: GithubSeen): Promise<void> {
	try {
		await AsyncStorage.setItem(GITHUB_SEEN_KEY, JSON.stringify(seen));
	} catch {
		/* best-effort: a box that shows no accounts just offers fewer to pick */
	}
}

/** The wide-window sidebar's explicit choice, independent of window size. */
export async function loadSidebarCollapsed(): Promise<boolean> {
	try {
		return (await AsyncStorage.getItem(SIDEBAR_COLLAPSED_KEY)) === "1";
	} catch {
		return false;
	}
}

export async function saveSidebarCollapsed(collapsed: boolean): Promise<void> {
	try {
		await AsyncStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
	} catch {
		/* best-effort: the choice still applies for this app session */
	}
}
