import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureNotifyScript } from "../src/agent-setup";
import { FollowUps } from "../src/follow-ups";
import { HookServer } from "../src/hooks/hook-server";

describe("FollowUps", () => {
	it("arms and hands out the text once", () => {
		const f = new FollowUps();
		f.arm("t1", "/check");
		expect(f.take("t1", "Stop")).toBe("/check");
		// Consume-once is the termination guarantee: a run cannot continue itself
		// a second time even if the agent stops again.
		expect(f.take("t1", "Stop")).toBeUndefined();
		expect(f.size).toBe(0);
	});

	it("only fires at a real turn end", () => {
		const f = new FollowUps();
		f.arm("t1", "/check");
		// A pending permission prompt must never consume the follow-up, or the
		// answer to a question would be swallowed as the follow-up turn.
		expect(f.take("t1", "PermissionRequest")).toBeUndefined();
		expect(f.take("t1", "Working")).toBeUndefined();
		expect(f.take("t1", "Stop")).toBe("/check");
	});

	it("arms nothing for blank text, and trims", () => {
		const f = new FollowUps();
		f.arm("t1", "   ");
		f.arm("t2", undefined);
		f.arm("t3", "  run the checks  ");
		expect(f.size).toBe(1);
		expect(f.take("t3", "Stop")).toBe("run the checks");
	});

	it("keeps terminals independent and drops on discard", () => {
		const f = new FollowUps();
		f.arm("t1", "one");
		f.arm("t2", "two");
		f.discard("t1");
		expect(f.take("t1", "Stop")).toBeUndefined();
		expect(f.take("t2", "Stop")).toBe("two");
	});
});

// The shape below is the agent's own Stop-hook contract, verified against
// Claude Code 2.1.251: a `decision: "block"` reply is what turns a finished
// turn into another one, with `reason` as the instruction it acts on.
describe("hook server /hook/complete", () => {
	const hooks = new HookServer();
	const started = hooks.start(0);
	afterAll(() => hooks.stop());

	const complete = async (terminalId: string, eventType: string) => {
		const port = await started;
		const res = await fetch(
			`http://127.0.0.1:${port}/hook/complete?terminalId=${terminalId}&eventType=${eventType}`,
		);
		const text = await res.text();
		return { status: res.status, body: text ? JSON.parse(text) : null };
	};

	it("answers an empty 204 when nothing is armed", async () => {
		await started;
		const follow = new FollowUps();
		hooks.setFollowUpResolver((id, ev) => follow.take(id, ev));
		// The unchanged path every session without a follow-up takes: no body,
		// so notify.sh prints nothing and the agent stops as it always has.
		const r = await complete("term-none", "Stop");
		expect(r.status).toBe(204);
		expect(r.body).toBeNull();
	});

	it("returns the continuation JSON for an armed terminal, once", async () => {
		await started;
		const follow = new FollowUps();
		hooks.setFollowUpResolver((id, ev) => follow.take(id, ev));
		follow.arm("term-armed", "/check");

		const first = await complete("term-armed", "Stop");
		expect(first.status).toBe(200);
		expect(first.body).toEqual({ decision: "block", reason: "/check" });

		const second = await complete("term-armed", "Stop");
		expect(second.status).toBe(204);
		expect(second.body).toBeNull();
	});

	it("does not continue a turn that ended on a permission prompt", async () => {
		await started;
		const follow = new FollowUps();
		hooks.setFollowUpResolver((id, ev) => follow.take(id, ev));
		follow.arm("term-ask", "/check");

		const asked = await complete("term-ask", "PermissionRequest");
		expect(asked.status).toBe(204);
		// Still armed: it fires on the turn end that actually follows.
		const stopped = await complete("term-ask", "Stop");
		expect(stopped.body).toEqual({ decision: "block", reason: "/check" });
	});

	it("still emits the status event it always did", async () => {
		await started;
		const follow = new FollowUps();
		hooks.setFollowUpResolver((id, ev) => follow.take(id, ev));
		follow.arm("term-evt", "/check");
		const seen: string[] = [];
		hooks.on("hook", (e) => seen.push(`${e.terminalId}:${e.eventType}`));
		await complete("term-evt", "Stop");
		expect(seen).toContain("term-evt:Stop");
	});
});

// The notify script is generated shell: nothing typechecks it, and a quoting
// slip would only show up as an agent that silently never continues. So run the
// REAL script against a REAL server and read the bytes Claude would read.
describe("notify.sh follow-up echo", () => {
	it("prints the continuation JSON, and nothing when unarmed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ateam-followup-"));
		const scriptPath = await ensureNotifyScript(dir);
		const hooks = new HookServer();
		const port = await hooks.start(0);
		const follow = new FollowUps();
		hooks.setFollowUpResolver((id, ev) => follow.take(id, ev));
		follow.arm("term-sh", "/check");

		const run = async (eventType: string) => {
			const proc = Bun.spawn(["sh", scriptPath, eventType], {
				env: {
					...process.env,
					ATEAM_HOOK_PORT: String(port),
					ATEAM_TERMINAL_ID: "term-sh",
				},
				stdout: "pipe",
			});
			const out = await new Response(proc.stdout).text();
			await proc.exited;
			return { out, code: proc.exitCode };
		};

		const armed = await run("Stop");
		expect(JSON.parse(armed.out)).toEqual({ decision: "block", reason: "/check" });
		expect(armed.code).toBe(0);

		// Consumed: the next turn end prints nothing at all, which is what every
		// ordinary session sees on every Stop.
		const spent = await run("Stop");
		expect(spent.out).toBe("");
		expect(spent.code).toBe(0);

		hooks.stop();
		await rm(dir, { recursive: true, force: true });
	});
});
