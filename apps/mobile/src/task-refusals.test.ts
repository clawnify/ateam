import { expect, test } from "bun:test";
import { archiveError, needsForce } from "./task-refusals";

test("git refusing to drop work asks again; any other failure is just said", () => {
	expect(needsForce("fatal: 'wt' contains modified or untracked files, use --force")).toBe(true);
	expect(needsForce("error: The branch 'fix-login' is not fully merged.")).toBe(true);
	expect(needsForce("Task not found")).toBe(false);
	expect(needsForce("RPC timeout")).toBe(false);
});

test("a box with no archive says to update, other errors pass through", () => {
	expect(archiveError("Unknown method tasks:setArchived")).toMatch(/older Ateam/);
	expect(archiveError("Task not found")).toBe("Task not found");
});
