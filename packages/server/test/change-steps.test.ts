import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { AteamDb, Task } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import type { DiffFile } from "@ateam/git-core";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import {
	accountFrom,
	buildStepsPrompt,
	type ChangeStepsDeps,
	createChangeSteps,
	diffKey,
	MAX_ACCOUNT_CHARS,
	parseSteps,
	patchText,
	STEPS_MIN_FILES,
} from "../src/change-steps";
import { headlessArgs } from "../src/headless";

function createTestDb(): AteamDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as AteamDb;
}

const file = (path: string, additions = 3, deletions = 1): DiffFile => ({
	path,
	additions,
	deletions,
	binary: false,
	untracked: false,
});

const PATHS = Array.from({ length: STEPS_MIN_FILES }, (_, i) => `src/f${i}.ts`);
const FILES = PATHS.map((p) => file(p));

/** A model reply covering PATHS: two steps, one file left unexplained. */
const REPLY = JSON.stringify({
	layers: [
		{
			title: "Store the new field",
			why: "The board needs it.",
			files: PATHS.slice(0, 4).map((path) => ({ path, note: "adds it" })),
		},
		{
			title: "Show it on the card",
			why: "So the user sees it.",
			files: PATHS.slice(4, 7).map((path) => ({ path, note: "draws it" })),
		},
	],
	unexplained: [{ path: PATHS[7], note: "renamed a helper" }],
});

describe("diffKey", () => {
	it("names a diff by its files and counts, in any order", () => {
		const a = diffKey([file("a.ts"), file("b.ts")]);
		expect(diffKey([file("b.ts"), file("a.ts")])).toBe(a);
		expect(diffKey([file("a.ts"), file("b.ts", 4)])).not.toBe(a);
		expect(diffKey([file("a.ts")])).not.toBe(a);
	});
});

describe("parseSteps", () => {
	it("reads a reply that covers every file", () => {
		const body = parseSteps(REPLY, PATHS);
		expect(body?.steps.map((s) => s.title)).toEqual(["Store the new field", "Show it on the card"]);
		expect(body?.unexplained).toEqual([{ path: "src/f7.ts", note: "renamed a helper" }]);
	});

	it("finds the JSON inside a code fence or prose, and the paths git wrote", () => {
		const fenced = `Here it is:\n\`\`\`json\n${REPLY.replaceAll('"src/', '"./src/')}\n\`\`\``;
		expect(parseSteps(fenced, PATHS)?.steps).toHaveLength(2);
		expect(parseSteps(REPLY.replaceAll('"src/', '"b/src/'), PATHS)?.steps).toHaveLength(2);
	});

	it("refuses a reply that invents a path", () => {
		expect(parseSteps(REPLY.replace("src/f0.ts", "src/made-up.ts"), PATHS)).toBeNull();
	});

	it("refuses a reply that leaves a changed file out", () => {
		expect(parseSteps(REPLY, [...PATHS, "src/missing.ts"])).toBeNull();
	});

	it("refuses what isn't the agreed shape", () => {
		expect(parseSteps("no json here", PATHS)).toBeNull();
		expect(parseSteps('{"layers":[]}', PATHS)).toBeNull();
		expect(parseSteps('{"layers":[{"title":"","files":[]}]}', PATHS)).toBeNull();
	});

	it("lists a file once per step even when the model repeats it", () => {
		const twice = JSON.stringify({
			layers: [
				{
					title: "All of it",
					why: "",
					files: [...PATHS, PATHS[0]].map((path) => ({ path, note: "x" })),
				},
			],
		});
		expect(parseSteps(twice, PATHS)?.steps[0]?.files).toHaveLength(PATHS.length);
	});
});

describe("accountFrom", () => {
	it("keeps the newest replies that fit, oldest first", () => {
		const big = "x".repeat(MAX_ACCOUNT_CHARS / 2 + 1);
		const account = accountFrom([
			{ role: "user", text: "build it", at: 1 },
			{ role: "agent", text: `old ${big}`, at: 2 },
			{ role: "user", text: "now the docs", at: 3 },
			{ role: "agent", text: `new ${big}`, at: 4 },
			{ role: "agent", text: "last", at: 5 },
		]);
		expect(account.asked).toEqual(["build it", "now the docs"]);
		expect(account.replies.map((r) => r.slice(0, 4))).toEqual(["new ", "last"]);
	});
});

describe("patchText", () => {
	it("joins patches that fit as they are", () => {
		const out = patchText([
			{ path: "a", patch: "aaa\n" },
			{ path: "b", patch: "bbb\n" },
		]);
		expect(out).toEqual({ text: "aaa\n\nbbb\n", clipped: [] });
	});

	it("cuts only the big files, at a line, so the small ones stay whole", () => {
		const big = `${"line of a generated file\n".repeat(400)}`;
		const out = patchText(
			[
				{ path: "small.ts", patch: "+one\n" },
				{ path: "huge.json", patch: big },
			],
			2_000,
		);
		expect(out.clipped).toEqual(["huge.json"]);
		expect(out.text).toContain("+one\n");
		expect(out.text).toContain("[… the rest of huge.json's patch is not shown]");
		expect(out.text.length).toBeLessThan(2_100);
	});
});

describe("buildStepsPrompt", () => {
	it("carries the ask, the account, every file and the patch", () => {
		const prompt = buildStepsPrompt({
			asked: ["add a dot"],
			replies: ["Added the dot to the card."],
			files: [file("a.ts", 5, 2), { ...file("logo.png"), binary: true }],
			patch: "diff --git a/a.ts b/a.ts",
			clipped: [],
		});
		expect(prompt).toContain("add a dot");
		expect(prompt).toContain("Added the dot to the card.");
		expect(prompt).toContain("a.ts +5 -2");
		expect(prompt).toContain("logo.png (binary)");
		expect(prompt).toContain("diff --git a/a.ts b/a.ts");
		expect(prompt).not.toContain("cut short");
	});
});

describe("headlessArgs", () => {
	const claude = {
		args: ["-p", "--model", "haiku", "--output-format", "text"],
		prompt: "stdin" as const,
		modelFlag: "--model",
	};
	it("keeps the registry's args without a model", () => {
		expect(headlessArgs(claude)).toEqual(claude.args);
	});
	it("puts the caller's model in place of the pinned one", () => {
		expect(headlessArgs(claude, { model: "sonnet" })).toEqual([
			"-p",
			"--model",
			"sonnet",
			"--output-format",
			"text",
		]);
	});
	it("ignores the model for an agent that names no model flag", () => {
		const codex = { args: ["exec", "--sandbox", "read-only"], prompt: "stdin" as const };
		expect(headlessArgs(codex, { model: "sonnet" })).toEqual(codex.args);
	});
});

describe("createChangeSteps", () => {
	let db: AteamDb;
	let projectId: string;
	let files: DiffFile[];
	let asks: string[];
	let reply: string;
	let release: () => void;
	let gate: Promise<void>;

	const deps = (over: Partial<ChangeStepsDeps> = {}): ChangeStepsDeps => ({
		db,
		diffOf: async () => files,
		patchesOf: async (_t, paths) => paths.map((path) => ({ path, patch: `+${path}\n` })),
		turnsOf: async () => [
			{ role: "user", text: "add the field", at: 1 },
			{ role: "agent", text: "Added the field and showed it.", at: 2 },
		],
		lastMergeAt: async () => null,
		ask: async (_agent, prompt) => {
			asks.push(prompt);
			await gate;
			return reply;
		},
		now: () => 1_000,
		...over,
	});

	const seedTask = (patch: Partial<Task> = {}): string => {
		const id = repo.createTask(db, {
			projectId,
			name: "t",
			slug: "t",
			branch: "t",
			baseBranch: "main",
			worktreePath: "/tmp/t",
		}).id;
		repo.updateTask(db, id, { agentId: "claude", ...patch });
		return id;
	};
	/** Let a started write run to its end. */
	const settle = async () => {
		release();
		for (let i = 0; i < 10; i++) await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
	};

	beforeEach(() => {
		db = createTestDb();
		projectId = repo.upsertProject(db, {
			repoPath: "/tmp/repo",
			name: "Repo",
			defaultBranch: "main",
		}).id;
		files = FILES;
		asks = [];
		reply = REPLY;
		gate = new Promise((r) => {
			release = r;
		});
	});

	it("writes steps for a big diff, then answers from the table", async () => {
		const steps = createChangeSteps(deps());
		const id = seedTask();
		expect(await steps.get(id)).toMatchObject({ working: true, steps: null, current: false });
		expect(steps.busy()).toBe(true);
		// Polled while it runs: no second call.
		expect(await steps.get(id)).toMatchObject({ working: true });
		await settle();
		expect(steps.busy()).toBe(false);
		const ready = await steps.get(id);
		expect(ready).toMatchObject({ working: false, current: true, madeAt: 1_000 });
		expect(ready.steps).toHaveLength(2);
		expect(asks).toHaveLength(1);
		expect(asks[0]).toContain("Added the field and showed it.");
	});

	it("marks the steps out of date when the diff moves on, and writes new ones", async () => {
		const steps = createChangeSteps(deps());
		const id = seedTask();
		await steps.get(id);
		await settle();
		files = FILES.map((f, i) => (i === 0 ? { ...f, additions: 9 } : f));
		gate = new Promise((r) => {
			release = r;
		});
		const moved = await steps.get(id);
		expect(moved).toMatchObject({ working: true, current: false });
		expect(moved.steps).toHaveLength(2);
		await new Promise((r) => setTimeout(r, 0));
		expect(asks).toHaveLength(2);
	});

	it("writes nothing for a small diff or an agent that can't", async () => {
		const steps = createChangeSteps(deps());
		files = FILES.slice(0, STEPS_MIN_FILES - 1);
		expect(await steps.get(seedTask())).toMatchObject({ unavailable: "small", working: false });
		files = FILES;
		expect(await steps.get(seedTask({ agentId: "opencode" }))).toMatchObject({
			unavailable: "agent",
		});
		expect(asks).toHaveLength(0);
	});

	it("says a write failed, and doesn't retry the same diff at once", async () => {
		reply = "sorry, no JSON";
		const steps = createChangeSteps(deps());
		const id = seedTask();
		await steps.get(id);
		await settle();
		expect(await steps.get(id)).toMatchObject({ unavailable: "failed", working: false });
		expect(asks).toHaveLength(1);
	});

	it("reads the account from the newest merge on, and falls back to the last reply", async () => {
		let since: number | null = -1;
		const steps = createChangeSteps(
			deps({
				lastMergeAt: async () => 500,
				turnsOf: async (_t, s) => {
					since = s;
					return [];
				},
			}),
		);
		const id = seedTask({ lastReply: "Only this turn's report." });
		await steps.get(id);
		await settle();
		expect(since).toBe(500);
		expect(asks[0]).toContain("Only this turn's report.");
	});
});
