// The SleepDriver for a box on Fly.io Sprites. A Sprite pauses on its own a few
// seconds after nothing is using it, and an agent working inside doesn't count:
// only session output, a connection opened through Fly (the desktop's SSH is
// one), or a task hold keeps it up. So the engine holds with a task on the
// Sprite's own API socket and releases by deleting it:
//
//   hold     PUT /v1/tasks/ateam-engine with an expiry, renewed on a timer:
//            Fly refuses a hold longer than an hour, and the engine calls
//            hold() only when it changes its mind (./control.ts). If the
//            engine dies, the hold lapses on its own within HOLD_EXPIRE.
//   release  DELETE the task. Fly pauses the Sprite once nothing else is going.
//
// A Sprite can't be woken on a schedule, so canWakeForLoops is false: the engine
// keeps a Sprite with a live loop held (sleepMode in ./control.ts).
//
// Every one of those behaviours was measured on a real Sprite on 2026-10-24;
// see docs/providers/sprites.md. The socket needs no key: it is the Sprite's own.
import { existsSync } from "node:fs";
import { request } from "node:http";
import { hostname } from "node:os";
import type { SleepDriver } from "./control";

/** The Sprite's management API, present in every Sprite and nowhere else. */
export const SPRITE_SOCKET = "/.sprite/api.sock";
/** The engine's task. One fixed name, so renewing it renews the same hold. */
export const HOLD_TASK = "ateam-engine";
/** How long one renewal holds. */
export const HOLD_EXPIRE = "10m";
/** Renewed well inside the expiry, so one failed renewal doesn't drop the hold. */
export const HOLD_RENEW_MS = 4 * 60_000;

/** One call to the socket's tasks API, resolving with the HTTP status. */
export type TaskCall = (method: "PUT" | "DELETE", task: string, body?: string) => Promise<number>;

const taskCall: TaskCall = (method, task, body) =>
	new Promise((resolve, reject) => {
		const req = request(
			{
				socketPath: SPRITE_SOCKET,
				method,
				path: `/v1/tasks/${task}`,
				headers: { host: "sprite", "content-type": "application/json" },
				timeout: 10_000,
			},
			(res) => {
				res.resume();
				res.on("end", () => resolve(res.statusCode ?? 0));
			},
		);
		req.on("timeout", () => req.destroy(new Error("the Sprite's API socket timed out")));
		req.on("error", reject);
		req.end(body);
	});

/** Runs `fn` every `ms` until the returned function is called. */
export type Every = (fn: () => void, ms: number) => () => void;

const every: Every = (fn, ms) => {
	const timer = setInterval(fn, ms);
	timer.unref?.();
	return () => clearInterval(timer);
};

/** The driver when the engine runs inside a Sprite, else null. */
export async function spritesSleepDriver(opts: {
	log: (line: string) => void;
	call?: TaskCall;
	every?: Every;
	isSprite?: () => boolean;
}): Promise<SleepDriver | null> {
	const isSprite = opts.isSprite ?? (() => existsSync(SPRITE_SOCKET));
	if (!isSprite()) return null;
	const call = opts.call ?? taskCall;
	const repeat = opts.every ?? every;
	const put = async () => {
		const status = await call("PUT", HOLD_TASK, JSON.stringify({ expire: HOLD_EXPIRE }));
		if (status !== 200 && status !== 201) throw new Error(`Sprites refused the hold (HTTP ${status})`);
	};
	let stopRenewing: (() => void) | null = null;
	return {
		where: `Sprite ${hostname()}`,
		canWakeForLoops: false,
		hold: async () => {
			await put();
			stopRenewing ??= repeat(() => {
				put().catch((err: unknown) =>
					opts.log(
						`[ateam] renewing the Sprite's hold failed: ${err instanceof Error ? err.message : String(err)}`,
					),
				);
			}, HOLD_RENEW_MS);
		},
		release: async () => {
			stopRenewing?.();
			stopRenewing = null;
			const status = await call("DELETE", HOLD_TASK);
			// 404 is a hold already gone (lapsed, or never taken): what a release wants.
			if (status !== 204 && status !== 200 && status !== 404) {
				throw new Error(`Sprites refused the release (HTTP ${status})`);
			}
		},
		// Never called: with canWakeForLoops false, the engine doesn't release a box a loop needs.
		armWake: async () => {},
	};
}
