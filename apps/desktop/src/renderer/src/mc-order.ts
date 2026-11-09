import type { McPins } from "@ateam/protocol";

export {
	byMcPriority,
	holdMcTile,
	orderMcTiles,
	pinMcArrival,
	pinMcSwap,
	stabilizeMcPages,
	undoMcPins,
	type McPins,
} from "@ateam/protocol";

export function readMcPins(key: string): McPins {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		return Object.fromEntries(
			Object.entries(value).filter(([, slot]) => Number.isSafeInteger(slot) && slot >= 0),
		);
	} catch {
		return {};
	}
}
