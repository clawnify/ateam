import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { viewerInputScript } from "../src/viewer-input";

type State = { controlling: boolean };
type Request = (action: string) => Promise<State>;
type Handoff = {
	begin(): Promise<void>;
	release(): void;
	sync(state: State, generation: number): void;
	closed: boolean;
	generation: number;
	owned: boolean;
};
const InputHandoff = runInNewContext(
	`${viewerInputScript.replace("export class", "class")}\nInputHandoff;`,
) as new (
	socket: { send(data: Uint8Array): void; close(): void },
	request: Request,
	enable: (value: boolean) => void,
	fail: (error: Error) => void,
) => Handoff;
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((a, b) => {
		resolve = a;
		reject = b;
	});
	return { promise, resolve, reject };
}
function setup(request: Request) {
	const sent: number[][] = [],
		errors: string[] = [];
	let enabled = false,
		closed = false;
	const socket = {
		send(data: Uint8Array) {
			sent.push(Array.from(data));
		},
		close() {
			closed = true;
		},
	};
	const input = new InputHandoff(
		socket,
		request,
		(value) => {
			enabled = value;
		},
		(error) => {
			errors.push(error.message);
			socket.close();
		},
	);
	return { input, socket, sent, errors, enabled: () => enabled, closed: () => closed };
}

test("first click and key bytes wait for takeover, survive noVNC buffer reuse, and forward once", async () => {
	const take = deferred<State>();
	const f = setup(() => take.promise);
	f.socket.send(new Uint8Array([3])); // Pixel requests continue while watching.
	const taking = f.input.begin();
	const click = new Uint8Array([5, 1, 0, 20, 0, 30]);
	f.socket.send(click);
	click.fill(0);
	f.socket.send(new Uint8Array([4, 1, 0, 0, 0, 0, 0, 65]));
	expect(f.enabled()).toBe(true);
	expect(f.sent).toEqual([[3]]);
	take.resolve({ controlling: true });
	await taking;
	expect(f.sent).toEqual([[3], [5, 1, 0, 20, 0, 30], [4, 1, 0, 0, 0, 0, 0, 65]]);
	await f.input.begin();
	expect(f.sent).toHaveLength(3);
});

test("leaving during takeover invalidates delayed success and never replays input", async () => {
	const take = deferred<State>();
	const f = setup(() => take.promise);
	const taking = f.input.begin();
	await Promise.resolve();
	f.socket.send(new Uint8Array([5, 1, 0, 20, 0, 30]));
	f.input.release();
	take.resolve({ controlling: true });
	await taking;
	expect(f.closed()).toBe(true);
	expect(f.enabled()).toBe(false);
	expect(f.input.owned).toBe(false);
	expect(f.sent).toEqual([]);
});

test("failed or timed-out takeover discards queued input and closes its viewer", async () => {
	for (const state of [false, new Error("request timed out")]) {
		const f = setup(async () => {
			if (state instanceof Error) throw state;
			return { controlling: state };
		});
		const taking = f.input.begin();
		f.socket.send(new Uint8Array([4, 1]));
		await taking;
		expect(f.closed()).toBe(true);
		expect(f.enabled()).toBe(false);
		expect(f.sent).toEqual([]);
		expect(f.errors).toHaveLength(1);
	}
});

test("reacquiring waits for release and ignores status responses from before the handoff", async () => {
	const release = deferred<State>();
	const requests: string[] = [];
	const f = setup((action) => {
		requests.push(action);
		return action === "release" ? release.promise : Promise.resolve({ controlling: true });
	});
	const oldGeneration = f.input.generation;
	await f.input.begin();
	f.input.sync({ controlling: false }, oldGeneration);
	expect(f.enabled()).toBe(true);
	f.input.release();
	f.input.sync({ controlling: true }, f.input.generation);
	expect(f.enabled()).toBe(false);
	const taking = f.input.begin();
	await Promise.resolve();
	expect(requests).toEqual(["take", "release"]);
	release.resolve({ controlling: false });
	await taking;
	expect(requests).toEqual(["take", "release", "take"]);
	expect(f.enabled()).toBe(true);
});

test("a bounded queue fails closed when takeover stalls", async () => {
	const take = deferred<State>();
	const f = setup(() => take.promise);
	const taking = f.input.begin();
	f.socket.send(new Uint8Array(65537));
	take.resolve({ controlling: true });
	await taking;
	expect(f.closed()).toBe(true);
	expect(f.sent).toEqual([]);
	expect(f.errors).toHaveLength(1);
});

test("a delayed status from during release cannot restore old ownership", async () => {
	const release = deferred<State>();
	const requests: string[] = [];
	const f = setup((action) => {
		requests.push(action);
		return action === "release" ? release.promise : Promise.resolve({ controlling: true });
	});
	await f.input.begin();
	f.input.release();
	const oldGeneration = f.input.generation;
	release.resolve({ controlling: false });
	await new Promise((r) => setTimeout(r, 0));
	f.input.sync({ controlling: true }, oldGeneration);
	expect(f.input.owned).toBe(false);
	expect(f.enabled()).toBe(false);
	await f.input.begin();
	expect(requests).toEqual(["take", "release", "take"]);
});

test("the first gesture after another viewer takes over confirms ownership before sending", async () => {
	let owner = "A";
	const forwarded: number[][] = [];
	const requests: string[] = [];
	const socket = {
		send(data: Uint8Array) {
			if (owner === "A") forwarded.push(Array.from(data));
		},
		close() {},
	};
	const input = new InputHandoff(
		socket,
		async (action) => {
			requests.push(action);
			owner = "A";
			return { controlling: true };
		},
		() => {},
		() => {},
	);
	await input.begin();
	owner = "B"; // No status poll has informed A yet.
	const taking = input.begin();
	socket.send(new Uint8Array([5, 1, 0, 20, 0, 30]));
	expect(forwarded).toEqual([]);
	await taking;
	expect(requests).toEqual(["take", "take"]);
	expect(forwarded).toEqual([[5, 1, 0, 20, 0, 30]]);
});

test("phone text submission waits for an already-pending gesture takeover", async () => {
	const take = deferred<State>();
	const f = setup(() => take.promise);
	const first = f.input.begin();
	let submitted = false;
	const second = f.input.begin().then(() => {
		submitted = true;
	});
	await Promise.resolve();
	expect(submitted).toBe(false);
	take.resolve({ controlling: true });
	await Promise.all([first, second]);
	expect(submitted).toBe(true);
});
