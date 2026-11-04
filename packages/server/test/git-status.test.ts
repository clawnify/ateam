import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	advanceOrigin,
	commitFile,
	makeTempRepoPair,
	squashMergeOnOrigin,
	type TempRepo,
} from "../../git-core/test/helpers/temp-repo";
import { computeGitStatus } from "../src/worktree-sweep";

// Real clones and pushes outlive bun's 5s default.
setDefaultTimeout(20_000);

let repo: TempRepo;
beforeEach(async () => {
	repo = await makeTempRepoPair();
});
afterEach(async () => {
	await repo.cleanup();
});

// The card and the Mission Control tile show a task's size as +N -M from this
// snapshot, and the task panel's button shows it from a live diff. Both must
// count the same lines: committed work on the branch, edits not yet committed,
// and files git does not track yet.
describe("computeGitStatus", () => {
	it("counts the lines added and removed across committed, uncommitted and new files", async () => {
		await repo.git.checkoutLocalBranch("task");
		await writeFile(join(repo.work, "README.md"), "# temp repo, edited\nsecond line\n");
		await repo.git.add("README.md");
		await repo.git.commit("edit the readme");
		await writeFile(join(repo.work, "notes.txt"), "one\ntwo\nthree\n");

		const status = await computeGitStatus(repo.work, "main");

		// README: 2 lines in for 1 out. notes.txt: 3 new lines, untracked.
		expect(status.dirty).toBe(2);
		expect(status.additions).toBe(5);
		expect(status.deletions).toBe(1);
		// Only notes.txt is uncommitted: README is in a commit.
		expect(status.uncommitted).toBe(1);
	});

	it("counts modified, staged and untracked files as uncommitted", async () => {
		await repo.git.checkoutLocalBranch("task");
		await writeFile(join(repo.work, "README.md"), "# edited, not staged\n");
		await writeFile(join(repo.work, "staged.txt"), "staged\n");
		await repo.git.add("staged.txt");
		await writeFile(join(repo.work, "new.txt"), "new\n");

		const status = await computeGitStatus(repo.work, "main");

		expect(status.uncommitted).toBe(3);
	});

	// What an agent's tools and screenshots leave behind is not the task's work,
	// so a finished task holding only that must not read "uncommitted".
	it("leaves untracked leftovers out of uncommitted, and still counts new work", async () => {
		await repo.git.checkoutLocalBranch("task");
		await mkdir(join(repo.work, "apps", "web"), { recursive: true });
		await commitFile(repo.work, "apps/web/index.ts", "export {};\n", "web app");
		await commitFile(repo.work, "logo.png", "v1", "logo");
		await commitFile(repo.work, "old.ts", "export {};\n", "old");

		// Ateam's own hooks file in a Codex task's worktree.
		await mkdir(join(repo.work, ".codex"));
		await writeFile(join(repo.work, ".codex", "hooks.json"), "{}\n");
		// A tool folder below the top level, inside a tracked folder.
		await mkdir(join(repo.work, "apps", "web", ".claude"));
		await writeFile(join(repo.work, "apps", "web", ".claude", "sidenotes.md"), "note\n");
		await writeFile(join(repo.work, "Screenshot 2026-10-12 at 14.03.PNG"), "png");
		await writeFile(join(repo.work, "GEMINI.md"), "x\n");
		await writeFile(join(repo.work, "debug.log"), "x\n");
		await writeFile(join(repo.work, "tsup.config.bundled_2y2zp7a2j36.mjs"), "x\n");
		await writeFile(join(repo.work, "vite.config.ts.timestamp-1730000000000-ab12.mjs"), "x\n");

		expect((await computeGitStatus(repo.work, "main")).uncommitted).toBe(0);

		// New source, an untracked folder (its contents go unread), a tracked
		// image's edit and a staged rename (one entry, two paths) all count.
		await writeFile(join(repo.work, "feature.ts"), "export {};\n");
		await mkdir(join(repo.work, "shots"));
		await writeFile(join(repo.work, "shots", "a.png"), "png");
		await writeFile(join(repo.work, "logo.png"), "v2");
		await repo.git.mv("old.ts", "new.ts");

		expect((await computeGitStatus(repo.work, "main")).uncommitted).toBe(4);
	});

	// #482. A squash-merged branch whose file base edited before and after the
	// merge keeps counting in the diff (`dirty`), because base never held the
	// branch's exact version of it. The worktree is clean all the same, and
	// `uncommitted` must say so.
	it("reads a clean, squash-merged worktree as uncommitted 0 while its diff still counts", async () => {
		const lines = (...l: string[]) => `${l.join("\n")}\n`;
		const numbered = Array.from({ length: 20 }, (_, i) => `${i + 1}`);
		await advanceOrigin(repo, { file: "app.txt", content: lines(...numbered) });
		await repo.git.pull("origin", "main");
		await repo.git.checkoutLocalBranch("task");
		const mine = numbered.map((l, i) => (i >= 9 && i <= 11 ? `task ${l}` : l));
		await commitFile(repo.work, "app.txt", lines(...mine), "task: edit lines 10-12");
		await repo.git.push(["-u", "origin", "task"]);

		// Another PR edits the same file elsewhere, then the task's PR squashes in.
		await advanceOrigin(repo, { file: "app.txt", content: lines("other 1", ...numbered.slice(1)) });
		await squashMergeOnOrigin(repo, "task");
		// A later PR rewrites the very lines the task changed.
		const later = ["other 1", ...mine.slice(1)].map((l, i) =>
			i >= 9 && i <= 11 ? `later ${i + 1}` : l,
		);
		await advanceOrigin(repo, { file: "app.txt", content: lines(...later) });
		await repo.git.fetch("origin", "main");

		const status = await computeGitStatus(repo.work, "main");

		expect(status.dirty).toBe(1);
		expect(status.uncommitted).toBe(0);
		expect(status.ahead).toBe(0);
	});

	it("reads zero for a task with no work yet", async () => {
		await repo.git.checkoutLocalBranch("task");

		const status = await computeGitStatus(repo.work, "main");

		expect(status).toMatchObject({ dirty: 0, uncommitted: 0, additions: 0, deletions: 0 });
	});
});
