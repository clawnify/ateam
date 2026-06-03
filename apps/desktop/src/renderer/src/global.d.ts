import type { GroveApi } from "../../shared/types";

declare global {
	interface Window {
		grove: GroveApi;
	}
}

export {};
