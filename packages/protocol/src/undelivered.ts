// What a task's undelivered message (TaskDTO.undelivered) says to the user, in
// the one wording every client shows: the Lead chat, the Mac's banner, the
// task's panel.
import type { TaskUndeliveredDTO } from "./index";

/**
 * "Your message to fix login did not reach its agent: its agent quit 7 s after
 * Ateam started it, ...". Without `taskName` it reads as said on the task.
 */
export function undeliveredText(u: TaskUndeliveredDTO, taskName?: string): string {
	const user = u.from.includes("user");
	const lead = u.from.includes("lead");
	const who =
		user && lead ? "Your message and the Lead's" : user ? "Your message" : "The Lead's message";
	const to = taskName ? ` to ${taskName}` : "";
	if (u.state === "stalled")
		return `${who}${to} ${user && lead ? "have" : "has"} not reached its agent yet: ${u.why}. It goes in once that is answered.`;
	return `${who}${to} did not reach its agent: ${u.why}.`;
}
