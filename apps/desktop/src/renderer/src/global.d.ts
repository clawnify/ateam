import type { AteamApi } from "@ateam/protocol";

declare global {
	interface Window {
		ateam: AteamApi;
	}
}

export {};
