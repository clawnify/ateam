// What a connection attempt is doing, step by step: the tray under the box's card
// on the phone, and under the composer on the desktop. A woken box can take
// minutes to answer, so both keep trying (WOKEN_CONNECT_MS) and say where they are
// rather than spinning silently.
//
// Pure TS, so it runs on the phone, in the desktop and under bun test.

// A provider reports a box awake before its network and Ateam are up, so after a
// wake a client keeps trying the box for this long, WOKEN_RETRY_GAP_MS apart.
// Inside the Sprites hold (WAKE_HOLD_EXPIRE, 5 min) with room for the wake call.
export const WOKEN_CONNECT_MS = 3 * 60_000;
export const WOKEN_RETRY_GAP_MS = 3_000;

// A box that left without being asked is tried again: soon at first (a blip, or
// the network coming back after sleep), then at a steady pace. The cap bounds what
// an unreachable box costs (one connect attempt per interval) and how late a box
// woken elsewhere (another client, a loop) shows up live. Its cards stay on the
// board in between (board-snapshot.ts), so the cap is about freshness, not
// visibility. The desktop (main/host.ts) and the phone (src/links.ts) both use it.
export const RECONNECT_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

/** How long to wait before reconnect attempt `attempt` (0-based). */
export function reconnectDelay(attempt: number): number {
	return RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 120_000;
}

export type StepStatus = "done" | "active" | "failed";

export interface ConnectStep {
	label: string;
	status: StepStatus;
}

/** Close the active step as done and start `label`. */
export function beginStep(steps: ConnectStep[], label: string): ConnectStep[] {
	return [
		...steps.map((s) => (s.status === "active" ? { ...s, status: "done" as const } : s)),
		{ label, status: "active" },
	];
}

/** Rename the active step (a wait that counts up). */
export function relabelActive(steps: ConnectStep[], label: string): ConnectStep[] {
	return steps.map((s) => (s.status === "active" ? { ...s, label } : s));
}

/** Mark the active step as the one that failed. */
export function failActive(steps: ConnectStep[]): ConnectStep[] {
	return steps.map((s) => (s.status === "active" ? { ...s, status: "failed" as const } : s));
}

/** The active step's label, or null when nothing is in flight. */
export function activeLabel(steps: ConnectStep[]): string | null {
	return steps.find((s) => s.status === "active")?.label ?? null;
}

/** The wait for a woken box, with how long it has been going. */
export function waitingLabel(elapsedMs: number): string {
	const s = Math.floor(elapsedMs / 1000);
	const shown = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
	return `Waiting for the box to answer, ${shown}`;
}
