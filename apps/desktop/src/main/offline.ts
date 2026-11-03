// A box the app isn't holding still has a board: the one it showed last
// (@ateam/protocol board-snapshot.ts). Its board is kept on this Mac (the
// `hosts.snapshot` column), and an OFFLINE backend serves it in the engine's place.
import { type BoxSnapshot, offlineHandle } from "@ateam/protocol";
import type { Backend } from "./backend";

/** Serve a box's last-seen board while it isn't held. `label` names it in refusals. */
export function offlineBackend(snapshot: BoxSnapshot, label: string): Backend {
	return {
		kind: "remote",
		methods: [],
		handle: offlineHandle(snapshot, label),
		on: () => () => {},
		dispose: () => {},
	};
}
