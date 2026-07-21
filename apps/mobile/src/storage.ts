// Persist the last connection so the host/port survive app restarts and
// reinstalls — otherwise every launch (and every rebuild) starts blank and you
// retype the box's Tailscale IP. AsyncStorage is RN's simple key-value store.
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "ateam.connection";
const PROJECT_KEY = "ateam.selectedProject";

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
