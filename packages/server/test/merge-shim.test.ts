import { afterAll, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MergeEnqueueDTO } from "@ateam/protocol";
import { ensureGhShim } from "../src/agent-setup";
import { HookServer, type MergeRequestEvent } from "../src/hooks/hook-server";

// The real shell script an agent's `gh pr merge` runs, against a live hook
// server. Before this, the shim printed "merge queued" and exited 0 whatever
// happened, so a conflict in the queue never reached the agent that asked.
describe("gh shim → /merge/request", () => {
	const hooks = new HookServer();
	const started = hooks.start(0);
	const dirs = (async () => {
		const root = await mkdtemp(join(tmpdir(), "ateam-shim-"));
		await ensureGhShim(root);
		// A stand-in for the real gh, so a fall-through is observable.
		const realBin = join(root, "real-bin");
		await mkdir(realBin);
		await writeFile(join(realBin, "gh"), '#!/bin/sh\necho "REAL GH $*"\n', "utf8");
		await chmod(join(realBin, "gh"), 0o755);
		return { root, hooksDir: join(root, "hooks"), realBin };
	})();
	afterAll(async () => {
		hooks.stop();
		await rm((await dirs).root, { recursive: true, force: true });
	});

	let lastRequest: MergeRequestEvent | undefined;
	const answer = (r: MergeEnqueueDTO | null) =>
		hooks.setMergeHandler(async (e) => {
			lastRequest = e;
			return r;
		});

	const runShim = async (port: number) => {
		const { hooksDir, realBin } = await dirs;
		// Async on purpose: the hook server answering it lives in this process.
		const p = Bun.spawn([join(hooksDir, "gh"), "pr", "merge", "--squash", "--auto"], {
			env: {
				PATH: `${hooksDir}:${realBin}:/usr/bin:/bin`,
				ATEAM_HOOK_PORT: String(port),
				ATEAM_TERMINAL_ID: "term-1",
				ATEAM_HOOKS_DIR: hooksDir,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		return { code, out, err };
	};

	it("prints the merged PR and exits 0", async () => {
		answer({ ok: true, prNumber: 42, prUrl: null });
		const r = await runShim(await started);
		expect(r.code).toBe(0);
		expect(r.out).toContain("merged PR #42");
		expect(lastRequest).toEqual({ terminalId: "term-1", strategy: "squash" });
	});

	it("hands a conflict back to the agent with the files, exit 1", async () => {
		answer({ ok: false, reason: "conflict", conflicts: ["docs/a.md", "src/b.ts"] });
		const r = await runShim(await started);
		expect(r.code).toBe(1);
		expect(r.err).toContain("docs/a.md");
		expect(r.err).toContain("src/b.ts");
		expect(r.err).toContain("gh pr merge' again");
		expect(r.out).not.toContain("REAL GH");
	});

	it("reports busy and errors as failures, never as queued", async () => {
		answer({ ok: false, reason: "busy" });
		expect((await runShim(await started)).code).toBe(1);
		answer({ ok: false, reason: "error", message: "push rejected" });
		const r = await runShim(await started);
		expect(r.code).toBe(1);
		expect(r.err).toContain("push rejected");
	});

	it("falls through to the real gh for a terminal that is no task's", async () => {
		answer(null);
		const r = await runShim(await started);
		expect(r.code).toBe(0);
		expect(r.out).toContain("REAL GH pr merge --squash --auto");
	});

	it("falls through to the real gh when the app is unreachable", async () => {
		// Port 1 refuses connections: curl exit 7, the only fall-through case.
		const r = await runShim(1);
		expect(r.out).toContain("REAL GH pr merge");
	});
});
