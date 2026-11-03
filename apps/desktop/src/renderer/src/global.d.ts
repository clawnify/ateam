import type { AteamApi, AteamLead } from "@ateam/protocol";
import type { AteamHost } from "../../shared/host";
import type { AteamTheme } from "../../shared/theme";

declare global {
	interface Window {
		ateam: AteamApi;
		ateamHost: AteamHost;
		ateamLead: AteamLead;
		ateamTheme: AteamTheme;
	}
}

export {};
