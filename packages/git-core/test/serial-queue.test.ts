import { describe, expect, it } from "bun:test";
import { SerialQueue } from "../src/serial-queue";

/** Drain the microtask queue (and one macrotask) so queued tasks can advance. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** A promise plus its resolve/reject, for hand-driving task timing in tests. */
function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("SerialQueue", () => {
	it("runs tasks sharing a key strictly in order, never overlapping", async () => {
		const q = new SerialQueue();
		const log: string[] = [];
		const a = deferred<void>();
		const b = deferred<void>();

		const pa = q.enqueue("k", async () => {
			log.push("a:start");
			await a.promise;
			log.push("a:end");
		});
		const pb = q.enqueue("k", async () => {
			log.push("b:start");
			await b.promise;
			log.push("b:end");
		});

		// b must not start until a has fully settled.
		await flush();
		expect(log).toEqual(["a:start"]);

		a.resolve();
		await pa;
		await flush(); // let a's settle release b from the queue
		expect(log).toEqual(["a:start", "a:end", "b:start"]);

		b.resolve();
		await pb;
		expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
	});

	it("runs different keys concurrently", async () => {
		const q = new SerialQueue();
		const log: string[] = [];
		const x = deferred<void>();
		const y = deferred<void>();

		const px = q.enqueue("x", async () => {
			log.push("x:start");
			await x.promise;
		});
		const py = q.enqueue("y", async () => {
			log.push("y:start");
			await y.promise;
		});

		await flush();
		expect(log.sort()).toEqual(["x:start", "y:start"]);

		x.resolve();
		y.resolve();
		await Promise.all([px, py]);
	});

	it("a failing task does not break or stall the rest of its chain", async () => {
		const q = new SerialQueue();
		const order: string[] = [];

		const p1 = q.enqueue("k", async () => {
			order.push("1");
			throw new Error("boom");
		});
		const p2 = q.enqueue("k", async () => {
			order.push("2");
			return "ok";
		});

		await expect(p1).rejects.toThrow("boom");
		await expect(p2).resolves.toBe("ok");
		expect(order).toEqual(["1", "2"]);
	});

	it("fires onStart only when the task leaves the queue", async () => {
		const q = new SerialQueue();
		const started: string[] = [];
		const first = deferred<void>();

		const p1 = q.enqueue(
			"k",
			async () => {
				await first.promise;
			},
			() => started.push("1"),
		);
		q.enqueue(
			"k",
			async () => {},
			() => started.push("2"),
		);

		await flush();
		expect(started).toEqual(["1"]); // 2 is still queued
		expect(q.depth("k")).toBe(2);

		first.resolve();
		await p1;
		await flush();
		expect(started).toEqual(["1", "2"]);
	});

	it("reports depth and clears back to idle once drained", async () => {
		const q = new SerialQueue();
		expect(q.busy("k")).toBe(false);

		const d = deferred<void>();
		const p = q.enqueue("k", async () => {
			await d.promise;
		});
		expect(q.depth("k")).toBe(1);
		expect(q.busy("k")).toBe(true);

		d.resolve();
		await p;
		await flush();
		expect(q.depth("k")).toBe(0);
		expect(q.busy("k")).toBe(false);
	});
});
