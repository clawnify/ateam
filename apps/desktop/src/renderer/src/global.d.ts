import type { AteamApi, AteamLead } from "@ateam/protocol";
import type { AteamHost } from "../../shared/host";
import type { AteamTheme } from "../../shared/theme";
import type { AteamWindow } from "../../shared/window";

declare global {
	interface Window {
		ateam: AteamApi;
		ateamHost: AteamHost;
		ateamLead: AteamLead;
		ateamTheme: AteamTheme;
		ateamWindow: AteamWindow;
	}
}

export {};
