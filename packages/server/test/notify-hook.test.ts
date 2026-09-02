import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureNotifyScript } from "../src/agent-setup";

/**
 * Runs the REAL shipped notify.sh — the string every worktree's hooks invoke —
 * against a stub hook endpoint, so these assertions are about the script we
 * actually write to disk, not a reimplementation of its logic.
 *
 * The case under test: Claude's `Notification` hook is a general bus. It fires
 * for permission prompts, but also ~60s after every finished turn
 * (notification_type=idle_prompt). Reporting the idle ones as PermissionRequest
 * parked finished tasks in needs_attention and wedged loops, whose next tick
 * read that status as "previous run still active".
 */

let scriptPath: string;
let dir: string;
let port: number;
let server: ReturnType<typeof Bun.serve>;
/** Every eventType the script reported, in order. */
let reported: string[] = [];

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "ateam-notify-"));
	scriptPath = await ensureNotifyScript(dir);
	server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			reported.push(url.searchParams.get("eventType") ?? "");
			return new Response(null, { status: 204 });
		},
	});
	port = server.port;
});

afterAll(async () => {
	server.stop(true);
	await rm(dir, { recursive: true, force: true });
});

/** Invoke the hook exactly as Claude does: event in argv, JSON on stdin. */
async function fire(event: string, payload: unknown): Promise<string[]> {
	reported = [];
	const proc = Bun.spawn(["sh", scriptPath, event], {
		env: {
			...process.env,
			ATEAM_HOOK_PORT: String(port),
			ATEAM_TERMINAL_ID: "term-1",
		},
		stdin: new TextEncoder().encode(payload === undefined ? "" : JSON.stringify(payload)),
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
	return reported;
}

const notification = (notification_type: string) => ({
	session_id: "s1",
	hook_event_name: "Notification",
	notification_type,
});

describe("notify.sh", () => {
	test("reports the plain lifecycle events, which carry no notification_type", async () => {
		expect(await fire("Stop", { hook_event_name: "Stop", session_id: "s1" })).toEqual(["Stop"]);
		expect(await fire("Start", { hook_event_name: "SessionStart" })).toEqual(["Start"]);
		expect(await fire("Working", { hook_event_name: "PreToolUse" })).toEqual(["Working"]);
	});

	test("reports a tool approval from the dedicated PermissionRequest hook", async () => {
		// No notification_type on this payload: the filter must not touch it.
		expect(await fire("PermissionRequest", { hook_event_name: "PermissionRequest" })).toEqual([
			"PermissionRequest",
		]);
	});

	test("drops the idle notification that fires ~60s after every finished turn", async () => {
		expect(await fire("PermissionRequest", notification("idle_prompt"))).toEqual([]);
	});

	test("drops the other notifications that are not a request for a human", async () => {
		for (const type of [
			"agent_completed",
			"auth_success",
			"elicitation_complete",
			"elicitation_response",
			"quota_auto_resume_fired",
		]) {
			expect(await fire("PermissionRequest", notification(type))).toEqual([]);
		}
	});

	test("still reports notifications that genuinely need a human", async () => {
		for (const type of [
			"permission_prompt",
			"agent_needs_input",
			"elicitation_dialog",
			"elicitation_url_dialog",
		]) {
			expect(await fire("PermissionRequest", notification(type))).toEqual(["PermissionRequest"]);
		}
	});

	test("reports when there is no payload at all (older agents, empty stdin)", async () => {
		expect(await fire("Stop", undefined)).toEqual(["Stop"]);
	});
});
