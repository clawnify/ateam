import type { AteamApi } from "@ateam/protocol";
import type { AteamHost } from "../../shared/host";
import type { AteamLead } from "../../shared/lead";

declare global {
	interface Window {
		ateam: AteamApi;
		ateamHost: AteamHost;
		ateamLead: AteamLead;
	}
}

export {};
