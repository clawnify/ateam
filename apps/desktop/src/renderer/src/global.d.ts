import type { AteamApi, AteamLead } from "@ateam/protocol";
import type { AteamHost } from "../../shared/host";

declare global {
	interface Window {
		ateam: AteamApi;
		ateamHost: AteamHost;
		ateamLead: AteamLead;
	}
}

export {};
