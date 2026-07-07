// Persist the last connection so the host/port survive app restarts and
// reinstalls — otherwise every launch (and every rebuild) starts blank and you
// retype the box's Tailscale IP. AsyncStorage is RN's simple key-value store.
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "ateam.connection";

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
