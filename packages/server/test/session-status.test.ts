// A session's status is what isWorking() reads to decide whether its box may sleep.
import { describe, expect, it } from "bun:test";
import { sessionStatusAfter } from "../src/engine";

describe("sessionStatusAfter", () => {
	it("a resume's Start leaves an idle session idle, so its box can sleep", () => {
		// Opening a stopped task resumes its conversation: SessionStart fires, and
		// nothing else does until someone types. It used to read as running for good.
		expect(sessionStatusAfter("Start", "idle")).toBe("idle");
	});

	it("a Start mid-turn (compaction) keeps the session running", () => {
		expect(sessionStatusAfter("Start", "running")).toBe("running");
		expect(sessionStatusAfter("Start", "awaiting_input")).toBe("awaiting_input");
	});

	it("every other event sets the status as before", () => {
		expect(sessionStatusAfter("UserReply", "idle")).toBe("running");
		expect(sessionStatusAfter("Working", "idle")).toBe("running");
		expect(sessionStatusAfter("PermissionRequest", "running")).toBe("awaiting_input");
		expect(sessionStatusAfter("Stop", "running")).toBe("idle");
	});
});
