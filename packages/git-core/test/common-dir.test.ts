import { describe, expect, it } from "bun:test";
import { commonDirFrom } from "../src/project";

describe("commonDirFrom", () => {
	it("falls back to the repo's .git when git prints nothing, never the process's directory", () => {
		expect(commonDirFrom("", "/r/app")).toBe("/r/app/.git");
		expect(commonDirFrom("  \n", "/r/app")).toBe("/r/app/.git");
	});

	it("keeps git's absolute answer, and takes a relative one against the repo", () => {
		expect(commonDirFrom("/r/app/.git\n", "/r/app")).toBe("/r/app/.git");
		expect(commonDirFrom("/r/main/.git", "/r/app-worktree")).toBe("/r/main/.git");
		expect(commonDirFrom(".git", "/r/app")).toBe("/r/app/.git");
	});
});
