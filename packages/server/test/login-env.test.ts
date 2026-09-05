import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { type AteamDb, bootstrap, repo } from "@ateam/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/src/schema";
import {
	appendMissingDirs,
	ensureLoginEnv,
	fallbackBinDirs,
	type LoginEnv,
	REFRESH_MIN_INTERVAL_MS,
	refreshLoginPath,
	resetLoginPathRefresh,
	sanitizeLoginPath,
} from "../src/login-env";

function createTestDb(): AteamDb {
	const sqlite = new Database(":memory:");
	bootstrap(sqlite);
	return drizzle(sqlite, { schema }) as unknown as AteamDb;
}

const BARE = "/usr/bin:/bin:/usr/sbin:/sbin";
const REAL = "/opt/homebrew/bin:/usr/bin:/bin";
const silent = () => {};

describe("sanitizeLoginPath", () => {
	test("keeps a real PATH intact", () => {
		expect(sanitizeLoginPath(REAL)).toBe(REAL);
	});

	test("strips escape sequences a shell leaked into the capture", () => {
		expect(sanitizeLoginPath("\u001B[0m/usr/bin:/bin\u001B[m")).toBe("/usr/bin:/bin");
	});

	test("rejects a capture naming no directory that exists", () => {
		expect(sanitizeLoginPath("/nope/not/here:/also/missing")).toBeNull();
		expect(sanitizeLoginPath("")).toBeNull();
	});
});

describe("appendMissingDirs", () => {
	test("adds only what the PATH lacks, keeping its order", () => {
		expect(appendMissingDirs("/usr/bin:/bin", ["/bin", "/opt/homebrew/bin"])).toBe(
			"/usr/bin:/bin:/opt/homebrew/bin",
		);
	});
});

describe("fallbackBinDirs", () => {
	test("names the two dirs fix-path's list misses", () => {
		const dirs = fallbackBinDirs("/Users/x");
		expect(dirs).toContain("/Users/x/.local/bin");
		expect(dirs).toContain("/opt/homebrew/bin");
	});
});

describe("ensureLoginEnv", () => {
	const opts = (db: AteamDb, env: NodeJS.ProcessEnv, probe: () => Promise<LoginEnv | null>) => ({
		db,
		env,
		probe,
		log: silent,
		platform: "darwin" as NodeJS.Platform,
		home: "/Users/x",
		retryDelaysMs: [] as number[],
	});

	test("adopts and remembers a resolved PATH", async () => {
		const db = createTestDb();
		const env: NodeJS.ProcessEnv = { PATH: BARE };
		await ensureLoginEnv(opts(db, env, async () => ({ path: REAL, lang: "en_GB.UTF-8" })));
		expect(env.PATH).toBe(REAL);
		expect(env.LANG).toBe("en_GB.UTF-8");
		expect(repo.getSettings(db).loginPath).toBe(REAL);
	});

	test("a miss falls back to the PATH last resolved on this machine", async () => {
		const db = createTestDb();
		repo.updateSettings(db, { loginPath: REAL });
		const env: NodeJS.ProcessEnv = { PATH: BARE };
		await ensureLoginEnv(opts(db, env, async () => null));
		expect(env.PATH).toBe(REAL);
		expect(env.LANG).toBe("en_US.UTF-8");
	});

	test("a miss with nothing remembered still reaches the agent CLI dirs", async () => {
		const db = createTestDb();
		const env: NodeJS.ProcessEnv = { PATH: BARE };
		await ensureLoginEnv(opts(db, env, async () => null));
		expect(env.PATH).toStartWith(BARE);
		expect(env.PATH).toContain("/Users/x/.local/bin");
		// A failed probe must never be remembered as a good answer.
		expect(repo.getSettings(db).loginPath).toBeNull();
	});

	test("a retry that lands replaces the fallback", async () => {
		const db = createTestDb();
		const env: NodeJS.ProcessEnv = { PATH: BARE };
		let calls = 0;
		const probe = async () => (++calls === 1 ? null : { path: REAL, lang: "" });
		await ensureLoginEnv({ ...opts(db, env, probe), retryDelaysMs: [1] });
		expect(env.PATH).not.toBe(REAL); // the first attempt missed
		await new Promise((r) => setTimeout(r, 20));
		expect(env.PATH).toBe(REAL);
		expect(repo.getSettings(db).loginPath).toBe(REAL);
	});

	test("does nothing off macOS, where the daemon starts from a login shell", async () => {
		const db = createTestDb();
		const env: NodeJS.ProcessEnv = { PATH: BARE };
		await ensureLoginEnv({
			...opts(db, env, async () => ({ path: REAL, lang: "" })),
			platform: "linux",
		});
		expect(env.PATH).toBe(BARE);
	});
});

// A CLI installed while the app is running is invisible to it: ensureLoginEnv
// resolves the PATH once at startup and returns on the first success, so
// without a refresh "restart Ateam" becomes the unwritten last step of every
// install. Seen for real with opencode, whose installer appends to ~/.zshrc.
describe("refreshLoginPath", () => {
	const opts = (db: AteamDb, env: NodeJS.ProcessEnv, path: string | null, now: number) => ({
		db,
		env,
		platform: "darwin" as NodeJS.Platform,
		now: () => now,
		probe: async (): Promise<LoginEnv | null> => (path ? { path, lang: "en_US.UTF-8" } : null),
	});

	test("adopts a PATH that moved, and says it moved", async () => {
		resetLoginPathRefresh();
		const db = createTestDb();
		const env: NodeJS.ProcessEnv = { PATH: BARE };
		expect(await refreshLoginPath(opts(db, env, REAL, 1_000_000))).toBe(true);
		expect(env.PATH).toBe(REAL);
		// Remembered, so a later startup whose probe misses still has it.
		expect(repo.getSettings(db).loginPath).toBe(REAL);
	});

	test("reports no change when the PATH is the same", async () => {
		resetLoginPathRefresh();
		const db = createTestDb();
		const env: NodeJS.ProcessEnv = { PATH: REAL };
		expect(await refreshLoginPath(opts(db, env, REAL, 1_000_000))).toBe(false);
	});

	test("won't pay for a second probe inside the interval", async () => {
		resetLoginPathRefresh();
		const db = createTestDb();
		const env: NodeJS.ProcessEnv = { PATH: BARE };
		let probes = 0;
		const counting = (now: number) => ({
			...opts(db, env, REAL, now),
			probe: async (): Promise<LoginEnv | null> => {
				probes++;
				return { path: REAL, lang: "" };
			},
		});
		await refreshLoginPath(counting(1_000_000));
		await refreshLoginPath(counting(1_000_000 + REFRESH_MIN_INTERVAL_MS - 1));
		expect(probes).toBe(1);
		// An interactive login shell can take PROBE_TIMEOUT_MS to answer; the
		// agent catalog and a launch about to be refused must not each spend that.
		await refreshLoginPath(counting(1_000_000 + REFRESH_MIN_INTERVAL_MS));
		expect(probes).toBe(2);
	});

	test("forces past the interval right after an install", async () => {
		resetLoginPathRefresh();
		const db = createTestDb();
		const env: NodeJS.ProcessEnv = { PATH: BARE };
		let probes = 0;
		const counting = () => ({
			...opts(db, env, REAL, 1_000_000),
			probe: async (): Promise<LoginEnv | null> => {
				probes++;
				return { path: REAL, lang: "" };
			},
		});
		await refreshLoginPath(counting());
		await refreshLoginPath({ ...counting(), force: true });
		expect(probes).toBe(2);
	});

	test("does nothing off darwin, where the daemon inherits a login shell", async () => {
		resetLoginPathRefresh();
		const db = createTestDb();
		const env: NodeJS.ProcessEnv = { PATH: BARE };
		expect(await refreshLoginPath({ ...opts(db, env, REAL, 1_000_000), platform: "linux" })).toBe(
			false,
		);
		expect(env.PATH).toBe(BARE);
	});
});
