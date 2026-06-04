import type { AteamApi } from "../../shared/types";

declare global {
	interface Window {
		ateam: AteamApi;
	}
}

export {};
