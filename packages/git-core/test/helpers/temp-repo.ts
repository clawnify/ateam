import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";

export interface TempRepo {
	/** Temp root holding everything (cleaned up by `cleanup`). */
	dir: string;
	/** Bare "remote" repo path (acts as origin). */
	origin: string;
	/** Working clone path — the project's primary checkout (main worktree). */
	work: string;
	git: SimpleGit;
	cleanup(): Promise<void>;
}

async function configIdentity(git: SimpleGit): Promise<void> {
	await git.addConfig("user.email", "tester@ateam.dev");
	await git.addConfig("user.name", "Grove Tester");
	await git.addConfig("commit.gpgsign", "false");
	await git.addConfig("init.defaultBranch", "main");
}

/**
 * Build a real bare `origin` + a working clone with one commit on `main`
 * pushed and tracking. We test against real git because every safety property
 * we care about is git's own behavior — mocking would prove nothing.
 */
export async function makeTempRepoPair(): Promise<TempRepo> {
	const dir = await mkdtemp(join(tmpdir(), "grove-git-"));
	const origin = join(dir, "origin.git");
	await simpleGit().raw(["init", "--bare", "-b", "main", origin]);

	const work = join(dir, "work");
	await simpleGit().clone(origin, work);

	const git = simpleGit(work);
	await configIdentity(git);

	await writeFile(join(work, "README.md"), "# temp repo\n");
	await git.add("README.md");
	await git.commit("init");
	await git.push(["-u", "origin", "main"]);

	return {
		dir,
		origin,
		work,
		git,
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

/**
 * Push a new commit to `origin/main` via a throwaway clone, simulating the
 * remote advancing (e.g. a merged PR). Returns the new commit sha.
 */
export async function advanceOrigin(
	repo: TempRepo,
	opts?: { file?: string; content?: string; message?: string },
): Promise<string> {
	const file = opts?.file ?? "feature.txt";
	const content = opts?.content ?? "advance\n";
	const message = opts?.message ?? "advance origin/main";

	const clone = await mkdtemp(join(repo.dir, "adv-"));
	await simpleGit().clone(repo.origin, clone);
	const g = simpleGit(clone);
	await configIdentity(g);
	await writeFile(join(clone, file), content);
	await g.add(".");
	await g.commit(message);
	const sha = (await g.revparse(["HEAD"])).trim();
	await g.push("origin", "main");
	return sha;
}

/** Convenience: write a file inside a worktree and stage+commit it. */
export async function commitFile(
	worktreePath: string,
	file: string,
	content: string,
	message: string,
): Promise<string> {
	await writeFile(join(worktreePath, file), content);
	const g = simpleGit(worktreePath);
	await g.add(".");
	await g.commit(message);
	return (await g.revparse(["HEAD"])).trim();
}
