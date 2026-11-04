// Boxes being set up over SSH, kept apart from whatever started them: the Add a box
// popover closes as a set-up starts, and the box's page (BoxPage.tsx) and Settings →
// Boxes show it from here, so clicking away no longer loses it. The install itself
// runs in the main process either way; this is what the screen knows about it.

import { useSyncExternalStore } from "react";
import type { HostStatus } from "../../../shared/host";

export interface BoxSetup {
	/** What was set up: an ssh_config alias or user@host, the box's alias once it's up. */
	dest: string;
	state: "running" | "failed" | "done";
	/** The installer's output so far (its last 64 KB). */
	log: string;
	/** Why it failed, in words. */
	error: string | null;
	/** Run it again, the same way. */
	retry: () => void;
}

type Run = (onLog: (chunk: string) => void) => Promise<HostStatus>;

const IPC_PREFIX = /^Error invoking remote method '[^']+': (Error: )?/;
const LOG_CAP = 64 * 1024;
/** How long a finished set-up stays, covering the moment before the box is listed. */
const DONE_KEPT_MS = 60_000;

const setups = new Map<string, BoxSetup>();
const running = new Map<string, Promise<HostStatus>>();
let snapshot: BoxSetup[] = [];
const listeners = new Set<() => void>();
const emit = () => {
	snapshot = [...setups.values()];
	for (const l of listeners) l();
};
const patch = (dest: string, change: Partial<BoxSetup>) => {
	const now = setups.get(dest);
	if (now) {
		setups.set(dest, { ...now, ...change });
		emit();
	}
};

/** Set `dest` up with `run`, or hand back the set-up already running for it. */
export function startSetup(dest: string, run: Run): Promise<HostStatus> {
	const already = running.get(dest);
	if (already) return already;
	setups.set(dest, {
		dest,
		state: "running",
		log: "",
		error: null,
		retry: () => void startSetup(dest, run).catch(() => {}),
	});
	emit();
	const done = run((chunk) => {
		const now = setups.get(dest);
		if (now) patch(dest, { log: (now.log + chunk).slice(-LOG_CAP) });
	})
		.then(
			(status) => {
				patch(dest, { state: "done" });
				// By then the box is one of the boxes, and its own page says the rest; a
				// finished set-up kept for good would come back as a box forgotten since.
				setTimeout(() => dismissSetup(dest), DONE_KEPT_MS);
				return status;
			},
			(err: unknown) => {
				const said = err instanceof Error ? err.message : String(err);
				patch(dest, { state: "failed", error: said.replace(IPC_PREFIX, "") });
				throw err;
			},
		)
		.finally(() => running.delete(dest));
	running.set(dest, done);
	return done;
}

/** Forget a set-up that isn't running (a failed one the user dismissed). */
export function dismissSetup(dest: string): void {
	if (running.has(dest) || !setups.delete(dest)) return;
	emit();
}

/** Every set-up this session, in the order they started. */
export function setupsNow(): BoxSetup[] {
	return snapshot;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useSetups(): BoxSetup[] {
	return useSyncExternalStore(subscribe, setupsNow);
}

export function useSetup(dest: string | null | undefined): BoxSetup | undefined {
	const all = useSetups();
	return dest ? all.find((s) => s.dest === dest) : undefined;
}
