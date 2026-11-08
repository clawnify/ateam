// The providers whose boxes the engine can put to sleep and wake for loops. Each
// driver recognises its own provider from inside the box and answers null
// anywhere else, so the first one that answers is this box's provider. Adding a
// provider is a driver beside ./boxd.ts and a line in DRIVERS; when to sleep
// (./control.ts) stays the same. See docs/providers/README.md.
import { readFileSync } from "node:fs";
import type { BoxWake, ProviderReport } from "@ateam/protocol";
import { boxdSleepDriver } from "./boxd";
import type { SleepDriver } from "./control";
import { spritesSleepDriver } from "./sprites";

export {
	type SleepControl,
	type SleepDriver,
	startSleepControl,
} from "./control";

export interface DetectOptions {
	log: (line: string) => void;
	/** The user set the box always on at its provider (boxd: hibernation off). */
	onAlwaysOn?: () => void;
}

const DRIVERS: ((opts: DetectOptions) => Promise<SleepDriver | null>)[] = [
	boxdSleepDriver,
	spritesSleepDriver,
];

/** The sleep driver for the box this engine runs on, or null when its provider has none. */
export async function detectSleepDriver(opts: DetectOptions): Promise<SleepDriver | null> {
	for (const detect of DRIVERS) {
		const driver = await detect(opts);
		if (driver) return driver;
	}
	return null;
}

/**
 * The provider of a box nothing puts to sleep, so it has no driver: hello only names
 * it, and a client shows the box as being there. exe.dev boots every VM with its own
 * init, `init=/exe.dev/bin/exe-init` on the kernel command line (read on a VM,
 * 2026-11-06), which a container or a copied file can't fake the way a path on disk
 * could be.
 */
export function alwaysOnProvider(cmdline = "/proc/cmdline"): BoxWake | null {
	let line: string;
	try {
		line = readFileSync(cmdline, "utf8");
	} catch {
		return null; // not Linux, or not readable: nothing to name
	}
	return /(^|\s)init=\/exe\.dev\//.test(line) ? { id: "exe", box: {} } : null;
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
