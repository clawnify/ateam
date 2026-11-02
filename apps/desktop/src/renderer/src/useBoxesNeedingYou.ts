import { PROTOCOL_VERSION } from "@ateam/protocol";
import { useEffect, useState } from "react";
import { boxesNeedingYou, boxRows } from "./boxes-settings";

const HOUR = 3_600_000;

/**
 * The connected boxes that need you (boxesNeedingYou), for the dots on Settings and
 * its Boxes section. Kept current as boxes connect and their GitHub access is read,
 * and hourly, since a token enters its last two weeks with nothing on the wire.
 * Reads only what the desktop holds: nothing here reaches a box.
 */
export function useBoxesNeedingYou(): ReadonlySet<string> {
	const [needing, setNeeding] = useState<ReadonlySet<string>>(() => new Set());
	useEffect(() => {
		let live = true;
		const load = async () => {
			const [list, held, release, github] = await Promise.all([
				window.ateamHost.list(),
				window.ateamHost.connected(),
				window.ateamHost.appRelease(),
				window.ateamHost.boxGithub(),
			]);
			if (!live) return;
			const rows = boxRows(list, held, {}, { protocol: PROTOCOL_VERSION, release });
			const next = boxesNeedingYou(rows, github, Date.now());
			setNeeding((prev) =>
				prev.size === next.size && [...next].every((a) => prev.has(a)) ? prev : next,
			);
		};
		const refresh = () => void load().catch(() => {});
		refresh();
		const off = window.ateamHost.onConnectionsChanged(refresh);
		const timer = setInterval(refresh, HOUR);
		return () => {
			live = false;
			off();
			clearInterval(timer);
		};
	}, []);
	return needing;
}
