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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** This machine's own auto-hibernate timeout in seconds (0 = never), or null when
 *  boxd won't say. `config list --json` answers numbers, where `get` says "60s". */
export async function hibernateTimeoutOf(run: Exec): Promise<number | null> {
	try {
		const list: unknown = JSON.parse(await run("boxd", ["machine", "config", "list", "--json"]));
		const value = (list as Record<string, unknown> | null)?.["auto-hibernate.timeout"];
		return typeof value === "number" ? value : null;
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
	/** Where the last auto-hibernate timeout Ateam set is kept, so a change made in
	 *  boxd since can be told from Ateam's own. */
	timeoutStatePath?: string;
	/** The user turned hibernation off in boxd (auto-hibernate 0) since Ateam last
	 *  set it, so it's theirs, not Ateam's own hold. (A new box starts always on in
	 *  Ateam anyway: cli.ts.) */
	onAlwaysOn?: () => void;
}): Promise<SleepDriver | null> {
	const run = opts.exec ?? exec;
	const name = await boxdMachineName(run);
	if (!name) return null;
	const scriptPath = opts.wakeScriptPath ?? join(homedir(), ".ateam", "boxd", "loop-wake.run.ts");
	const statePath =
		opts.timeoutStatePath ?? join(homedir(), ".ateam", "boxd", "auto-hibernate-set");
	// What Ateam last set, across restarts; null on a box upgraded from an engine that
	// kept no record, where a 0 may be Ateam's own hold, so nothing is read into it.
	let lastSet: number | null = null;
	try {
		if (existsSync(statePath)) {
			const n = Number(readFileSync(statePath, "utf8").trim());
			if (Number.isFinite(n)) lastSet = n;
		}
	} catch {
		/* no record: as on an upgraded box */
	}
	const adoptIfOff = async (why: string) => {
		if ((await hibernateTimeoutOf(run)) !== 0) return;
		opts.log(
			`[ateam] boxd machine ${name} was set never to hibernate ${why}: keeping it always on`,
		);
		opts.onAlwaysOn?.();
	};
	const canWake = await run("run", ["--help"]).then(
		() => true,
		() => false,
	);
	if (!canWake) {
		opts.log("[ateam] this boxd image has no `run`: a box with a live loop will stay awake");
	}
	const setTimeoutS = async (s: number) => {
		await run("boxd", ["machine", "config", "set", "auto-hibernate.timeout", String(s)]);
		lastSet = s;
		try {
			mkdirSync(dirname(statePath), { recursive: true });
			writeFileSync(statePath, `${s}\n`);
		} catch {
			/* only costs telling a later change in boxd from Ateam's own */
		}
	};
	const suspendOff = () => run("boxd", ["machine", "config", "set", "auto-suspend.timeout", "0"]);
	return {
		where: `boxd machine ${name}`,
		provider: { id: "boxd", box: { machine: name } },
		canWakeForLoops: canWake,
		hold: async () => {
			// Ateam had let it sleep, and the timeout reads off now: someone turned
			// hibernation off in boxd since, so it stays always on rather than being
			// put back to sleeping at the next release.
			if (lastSet !== null && lastSet > 0) await adoptIfOff("in boxd");
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
