// The SleepDriver for a box on boxd. It steers boxd's own auto-hibernate timer:
//
//   hold     auto-hibernate.timeout 0: boxd never sleeps the box.
//   release  auto-hibernate.timeout RELEASE_S, with idle.ignore-outbound on so
//            only connections opened TO the box count. boxd hibernates it once
//            nobody is connected and working on it.
//
// Both also turn off boxd's other idle timer, auto-suspend. It's off by default,
// but a box with it on is suspended even while held (measured: standby 70s after
// the last connection, hibernate timer off), so an agent working with nobody
// attached would be frozen mid-turn; and once released it would suspend rather
// than hibernate, where waking for a loop was never measured.
//
// It must be boxd's timer that does it, never `boxd machine hibernate`: a box
// hibernated on command is not woken for its scheduled jobs, while one boxd put
// to sleep itself is, shortly before the job is due. So the loop wake is a boxd
// job for the tick's minute (loopWakeScript).
//
// Every one of those behaviours was measured on real boxes on 2026-10-21; see
// docs/providers/boxd.md. The in-VM `boxd` and `run` CLIs are already
// authorised for their own machine, so none of this needs an API key.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SleepDriver } from "./control";

/** boxd's timeout once released: short, since the engine already waited out the idle window. */
export const RELEASE_S = 60;

/**
 * The boxd job that wakes the box for a loop tick at `at`. A cron for that
 * one UTC minute, so it fires once (and again only a year on, by which time
 * it has long been rewritten). The handler does nothing: being awake is the
 * point, and the engine's own timer runs the loop.
 */
export function loopWakeScript(at: number): string {
	const d = new Date(at);
	const spec = `${d.getUTCMinutes()} ${d.getUTCHours()} ${d.getUTCDate()} ${d.getUTCMonth() + 1} *`;
	return [
		"// Written by the Ateam engine: wakes this box for its next loop tick.",
		'import { every } from "@boxd/run";',
		`every("${spec}", async () => {});`,
		"",
	].join("\n");
}

export type Exec = (cmd: string, args: string[]) => Promise<string>;

const exec: Exec = (cmd, args) =>
	new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: 30_000 }, (err, stdout) =>
			err ? reject(err) : resolve(stdout),
		);
	});

/**
 * This machine's boxd name, or null when the engine is not inside a boxd VM.
 * `boxd info` exists only in the in-VM CLI: the laptop CLI rejects it, and a
 * plain VPS has no `boxd` at all, so either way the answer is null.
 */
export async function boxdMachineName(run: Exec = exec): Promise<string | null> {
	try {
		const info: unknown = JSON.parse(await run("boxd", ["info", "--json"]));
		const name = (info as { name?: unknown } | null)?.name;
		return typeof name === "string" && name ? name : null;
	} catch {
		return null;
	}
}

/** The driver when the engine runs inside a boxd VM, else null. */
export async function boxdSleepDriver(opts: {
	log: (line: string) => void;
	exec?: Exec;
	/** Where the loop-wake job is written. */
	wakeScriptPath?: string;
}): Promise<SleepDriver | null> {
	const run = opts.exec ?? exec;
	const name = await boxdMachineName(run);
	if (!name) return null;
	const scriptPath = opts.wakeScriptPath ?? join(homedir(), ".ateam", "boxd", "loop-wake.run.ts");
	const canWake = await run("run", ["--help"]).then(
		() => true,
		() => false,
	);
	if (!canWake) {
		opts.log("[ateam] this boxd image has no `run`: a box with a live loop will stay awake");
	}
	const setTimeoutS = (s: number) =>
		run("boxd", ["machine", "config", "set", "auto-hibernate.timeout", String(s)]);
	const suspendOff = () => run("boxd", ["machine", "config", "set", "auto-suspend.timeout", "0"]);
	return {
		where: `boxd machine ${name}`,
		canWakeForLoops: canWake,
		hold: async () => {
			await suspendOff();
			await setTimeoutS(0);
		},
		release: async () => {
			// Set first, so boxd never sees a short timeout while outbound traffic counts.
			await run("boxd", ["machine", "config", "set", "idle.ignore-outbound", "on"]);
			await suspendOff();
			await setTimeoutS(RELEASE_S);
		},
		// shortcut: a job armed for a loop that was since deleted or paused stays
		// registered, and wakes the box once at that minute for nothing (an idle
		// window of uptime). Remove it by id if that ever shows up on a bill.
		armWake: async (at) => {
			mkdirSync(dirname(scriptPath), { recursive: true });
			writeFileSync(scriptPath, loopWakeScript(at));
			// Re-running the same file replaces its job under the same id.
			await run("run", [scriptPath]);
		},
	};
}
