// What a connection attempt is doing, step by step, for the tray under the box's
// card (BoxesScreen) and the reconnecting view. A woken box can take minutes to
// answer, so the phone keeps trying (App.tsx connectTo) and says where it is
// rather than spinning silently.
//
// Pure TS, no React Native imports, so it runs under bun test.

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
