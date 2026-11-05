// The providers whose boxes the engine can put to sleep and wake for loops. Each
// driver recognises its own provider from inside the box and answers null
// anywhere else, so the first one that answers is this box's provider. Adding a
// provider is a driver beside ./boxd.ts and a line in DRIVERS; when to sleep
// (./control.ts) stays the same. See docs/providers/README.md.
import type { BoxWake, ProviderReport } from "@ateam/protocol";
import { boxdSleepDriver } from "./boxd";
import type { SleepDriver } from "./control";
import { spritesSleepDriver } from "./sprites";

export {
	type SleepControl,
	type SleepDriver,
	startSleepControl,
} from "./control";

const DRIVERS: ((opts: { log: (line: string) => void }) => Promise<SleepDriver | null>)[] = [
	boxdSleepDriver,
	spritesSleepDriver,
];

/** The sleep driver for the box this engine runs on, or null when its provider has none. */
export async function detectSleepDriver(log: (line: string) => void): Promise<SleepDriver | null> {
	for (const detect of DRIVERS) {
		const driver = await detect({ log });
		if (driver) return driver;
	}
	return null;
}

/**
 * What hello says about this box's provider (SystemInfo.provider): who it is and the
 * box's name there, plus whether the engine lets it sleep now. Idle sleep off (0) keeps
 * the box always on, so a client has nothing to wake and no key to ask for. Undefined
 * while detection runs, null on a box no provider sleeps.
 */
export function providerReport(
	provider: BoxWake | null | undefined,
	idleSleepMinutes: number,
): ProviderReport | null | undefined {
	if (!provider) return provider;
	return { ...provider, sleeps: Number.isFinite(idleSleepMinutes) && idleSleepMinutes > 0 };
}
