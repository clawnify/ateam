// When Get started (components/GetStarted.tsx) takes the board's place. With no
// project at all, always. On a new install it also stays once a project is added,
// for the steps after it (the AI keys, a first task), until the first task exists.
// Kept in localStorage as "open" or "done", decided on the first load: an install
// that already has projects then is an existing one, so the list never shows up
// for it while its tasks are still loading.

export type GetStartedState = "open" | "done" | null;

export const GET_STARTED_KEY = "ateam.getStarted";

interface Board {
	projectsLoaded: boolean;
	/** A detached project window, which is one project's board. */
	bound: boolean;
	projectCount: number;
	taskCount: number;
}

/** The state to keep after this load, or the same one when nothing changes. */
export function nextGetStarted(state: GetStartedState, b: Board): GetStartedState {
	if (!b.projectsLoaded || b.bound) return state;
	if (b.taskCount > 0) return "done";
	if (state === null) return b.projectCount === 0 ? "open" : "done";
	return state;
}

export function showsGetStarted(state: GetStartedState, b: Board): boolean {
	if (!b.projectsLoaded || b.bound) return false;
	if (b.projectCount === 0) return true;
	return state === "open" && b.taskCount === 0;
}

export function readGetStarted(): GetStartedState {
	try {
		const v = localStorage.getItem(GET_STARTED_KEY);
		return v === "open" || v === "done" ? v : null;
	} catch {
		return null;
	}
}

export function saveGetStarted(state: GetStartedState): void {
	try {
		if (state) localStorage.setItem(GET_STARTED_KEY, state);
	} catch {
		// Without storage the list shows only while there is no project, as before.
	}
}
