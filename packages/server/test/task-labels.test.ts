import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { AteamDb, Task } from "@ateam/db";
import { bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import { labelFromReply, labelTask } from "../src/task-labels";

function createTestDb(): AteamDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as AteamDb;
}

let db: AteamDb;
let projectId: string;
let notified: string[];

function seedTask(name: string, patch: Partial<Task> = {}): string {
	return repo.createTask(db, {
		projectId,
		name,
		slug: "on-sidebar-collapsed-i-am-not",
		branch: "on-sidebar-collapsed-i-am-not",
		baseBranch: "main",
		worktreePath: "/tmp/wt",
		description: "on sidebar collapsed I am not seeing the unread dot",
		...patch,
	}).id;
}

const task = (id: string) => repo.getTask(db, id) as Task;
const replying = (reply: string | null) => () => Promise.resolve(reply);
const deps = (ask: (prompt: string) => Promise<string | null>) => ({
	db,
	notifyTaskUpdated: (id: string) => notified.push(id),
	ask,
});

const REPLY = '{"title":"Unread dot in collapsed sidebar","tags":["ui","bug"]}';

beforeEach(() => {
	db = createTestDb();
	notified = [];
	const project = repo.upsertProject(db, {
		repoPath: "/tmp/repo",
		name: "Repo",
		defaultBranch: "main",
	});
	if (!project) throw new Error("failed to seed project");
	projectId = project.id;
});

describe("labelTask", () => {
	it("replaces a name nobody typed, once, and leaves the branch alone", async () => {
		const id = seedTask("on sidebar collapsed I am not", { nameAuto: true });
		await labelTask(deps(replying(REPLY)), id);
		expect(task(id).name).toBe("Unread dot in collapsed sidebar");
		expect(task(id).branch).toBe("on-sidebar-collapsed-i-am-not");
		expect(task(id).tags).toEqual(["ui", "bug"]);
		expect(task(id).nameAuto).toBe(false);
		expect(notified).toEqual([id]);
	});

	it("never renames a name someone chose, but still tags", async () => {
		const id = seedTask("Stripe webhooks");
		await labelTask(deps(replying(REPLY)), id);
		expect(task(id).name).toBe("Stripe webhooks");
		expect(task(id).tags).toEqual(["ui", "bug"]);
	});

	// Other agents learn names: one that changed later would lose them.
	it("gives the title one attempt: a failure keeps the first words for good", async () => {
		const id = seedTask("on sidebar collapsed I am not", { nameAuto: true });
		await labelTask(deps(replying(null)), id);
		expect(task(id).name).toBe("on sidebar collapsed I am not");
		expect(task(id).nameAuto).toBe(false);
		// A later launch retries the tags, never the name.
		await labelTask(deps(replying(REPLY)), id);
		expect(task(id).name).toBe("on sidebar collapsed I am not");
		expect(task(id).tags).toEqual(["ui", "bug"]);
	});

	it("never changes a title once written", async () => {
		const id = seedTask("on sidebar collapsed I am not", { nameAuto: true });
		await labelTask(deps(replying(REPLY)), id);
		repo.updateTask(db, id, { tags: null });
		await labelTask(deps(replying('{"title":"Something else","tags":["perf"]}')), id);
		expect(task(id).name).toBe("Unread dot in collapsed sidebar");
		expect(task(id).tags).toEqual(["perf"]);
	});

	it("does not call the model when there is nothing to label", async () => {
		let calls = 0;
		const ask = () => {
			calls += 1;
			return Promise.resolve(REPLY);
		};
		const tagged = seedTask("Tagged already", { tags: ["db"] });
		await labelTask(deps(ask), tagged);
		const noPrompt = seedTask("task 2026-11-01", { nameAuto: true, description: null });
		await labelTask(deps(ask), noPrompt, { files: ["/att/shot.png"] });
		expect(calls).toBe(0);
		// An image alone has no words to read: the title waits for the agent's reply.
		expect(task(noPrompt).nameAuto).toBe(true);
	});

	it("does nothing for a task deleted while the model was answering", async () => {
		const id = seedTask("on sidebar collapsed I am not", { nameAuto: true });
		await labelTask(
			deps(async () => {
				repo.deleteTask(db, id);
				return REPLY;
			}),
			id,
		);
		expect(repo.getTask(db, id)).toBeUndefined();
		expect(notified).toEqual([]);
	});

	describe("a prompt whose words cannot name the task", () => {
		const WAIT = '{"title":null,"tags":[]}';
		const FROM_REPLY = '{"title":"Answer routed to the Lead chat","tags":["bug"]}';
		const vague = () =>
			seedTask("what's going on?", { nameAuto: true, description: "what's going on?" });

		it("holds the title at launch, then names the task once from the first reply", async () => {
			const id = vague();
			await labelTask(deps(replying(WAIT)), id, { files: ["/att/shot.png"] });
			expect(task(id).name).toBe("what's going on?");
			expect(task(id).nameAuto).toBe(true);

			await labelFromReply(
				deps(replying(FROM_REPLY)),
				id,
				"Nothing is broken: the answer went to the Lead chat.",
			);
			expect(task(id).name).toBe("Answer routed to the Lead chat");
			expect(task(id).tags).toEqual(["bug"]);
			expect(task(id).nameAuto).toBe(false);

			// One attempt: later turns never rename it.
			await labelFromReply(deps(replying('{"title":"Something else","tags":[]}')), id, "Done.");
			expect(task(id).name).toBe("Answer routed to the Lead chat");
		});

		it("tells the model how many files came and what kind, never their names or paths", async () => {
			const id = vague();
			const seen: string[] = [];
			const ask = (prompt: string) => {
				seen.push(prompt);
				return Promise.resolve(WAIT);
			};
			await labelTask(deps(ask), id, {
				files: ["/Users/me/Clients/Acme invoice.pdf", "/att/a.png"],
			});
			expect(seen[0]).toContain("The user attached 1 image and 1 file, which you cannot see.");
			expect(seen[0]).not.toContain("Acme");
			expect(seen[0]).not.toContain("/att/");
		});

		it("names an image-only task from the reply alone", async () => {
			const id = seedTask("task 2026-11-04", { nameAuto: true, description: null });
			await labelTask(deps(replying(REPLY)), id, { files: ["/att/shot.png"] });
			const seen: string[] = [];
			await labelFromReply(
				deps((prompt) => {
					seen.push(prompt);
					return Promise.resolve(REPLY);
				}),
				id,
				"The screenshot shows the collapsed sidebar without its unread dot.",
			);
			expect(seen[0]).toContain("The agent's first reply:");
			expect(task(id).name).toBe("Unread dot in collapsed sidebar");
		});

		// The first turn can end while the launch's call is still out: its Stop finds
		// no title waiting, so the launch names the task from that reply itself.
		it("uses a reply that arrived while the launch's call was answering", async () => {
			const id = vague();
			let calls = 0;
			const ask = async () => {
				calls += 1;
				if (calls > 1) return FROM_REPLY;
				repo.updateTask(db, id, {
					lastReply: "The answer went to the Lead chat.",
					lastReplyAt: Date.now(),
				});
				await labelFromReply(deps(replying(FROM_REPLY)), id, "The answer went to the Lead chat.");
				return WAIT;
			};
			await labelTask(deps(ask), id, { files: ["/att/shot.png"] });
			expect(task(id).name).toBe("Answer routed to the Lead chat");
			expect(task(id).nameAuto).toBe(false);
		});

		it("keeps waiting across a resume, which brings no new words", async () => {
			const id = vague();
			await labelTask(deps(replying(WAIT)), id);
			let calls = 0;
			const ask = () => {
				calls += 1;
				return Promise.resolve(REPLY);
			};
			await labelTask(deps(ask), id, { resume: true });
			expect(task(id).nameAuto).toBe(true);
			expect(task(id).name).toBe("what's going on?");
			// The resume may still tag (the vague prompt gave none), never title.
			expect(calls).toBe(1);
		});

		it("leaves a named task alone at every turn end, without a call", async () => {
			const id = seedTask("on sidebar collapsed I am not", { nameAuto: true });
			await labelTask(deps(replying(REPLY)), id);
			let calls = 0;
			await labelFromReply(
				deps(() => {
					calls += 1;
					return Promise.resolve(REPLY);
				}),
				id,
				"Fixed.",
			);
			expect(calls).toBe(0);
		});

		it("spends the attempt on a title the sanitizer refused, rather than waiting", async () => {
			const id = vague();
			await labelTask(
				deps(
					replying('{"title":"A sentence that goes on far too long for any card title","tags":[]}'),
				),
				id,
			);
			expect(task(id).nameAuto).toBe(false);
		});
	});
});
