// Where the phone's WebSocket listener binds: ATEAM_WS_ADDR, else the address the
// installer keeps in <data dir>/ws-addr. The file is what lets an engine started any
// way serve the phone: by its service, by the installer's own check, or by an
// `ateam attach` that found none running. An address that lived only in a service's
// environment was lost by every other path, on a systemd box (#283) and again on a
// Sprite. Per box, so not in settings.json, which the desktop pushes to every box.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const WS_ADDR_FILE = "ws-addr";

export function resolveWsAddr(env: NodeJS.ProcessEnv, dataDir: string): string | undefined {
	const fromEnv = env.ATEAM_WS_ADDR?.trim();
	if (fromEnv) return fromEnv;
	try {
		return readFileSync(join(dataDir, WS_ADDR_FILE), "utf8").trim() || undefined;
	} catch {
		return undefined; // no file: the listener stays off, as it always has
	}
}
