import { expect, test } from "bun:test";
import { DesktopControl } from "../src/control";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("one owner, private capabilities, expiry and stale-token rejection", async () => {
	const c = new DesktopControl(30);
	try {
		const first = c.acquire("task A");
		expect(JSON.stringify(c.status())).not.toContain(first.lease);
		expect(() => c.acquire("task B")).toThrow("task A");
		await expect(c.act("invented", async () => {})).rejects.toThrow("No valid");
		await delay(50);
		const second = c.acquire("task B");
		expect(() => c.renew(first.lease)).toThrow("No valid");
		c.releaseAgent(second.lease);
		expect(c.status()).toBeNull();
	} finally {
		c.close();
	}
});

test("human takeover cancels running input, waits for cleanup, and rejects queued input", async () => {
	const c = new DesktopControl();
	const { lease } = c.acquire("agent");
	let cleaned = false;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const running = c.act(lease, async (signal) => {
		started();
		await new Promise<void>((resolve) =>
			signal.addEventListener("abort", () => resolve(), { once: true }),
		);
		await delay(20);
		cleaned = true;
	});
	const failed = running.catch((e: Error) => e);
	await ready;
	const queued = c.act(lease, async () => {
		throw new Error("must not run");
	});
	const rejected = queued.catch((e: Error) => e);
	const takeover = c.takeOver("viewer A");
	expect(c.canInput("viewer A")).toBe(false);
	expect(() => c.acquire("other agent")).toThrow("desktop viewer");
	await takeover;
	expect(cleaned).toBe(true);
	expect(c.canInput("viewer A")).toBe(true);
	expect(c.canInput("viewer B")).toBe(false);
	expect(((await failed) as Error).message).toContain("taken over");
	expect(((await rejected) as Error).message).toContain("No valid");
	c.releaseViewer("viewer B");
	expect(c.canInput("viewer A")).toBe(true);
	c.releaseViewer("viewer A");
	expect(c.acquire("next agent").lease).toBeTruthy();
	c.close();
});

test("disconnect during takeover does not resurrect human ownership", async () => {
	const c = new DesktopControl();
	const takeover = c.takeOver("viewer");
	c.releaseViewer("viewer");
	await takeover;
	expect(c.canInput("viewer")).toBe(false);
	expect(c.status()).toBeNull();
	c.close();
});

test("actions serialize even after release and reacquisition", async () => {
	const c = new DesktopControl();
	const a = c.acquire("A");
	let firstEnded = false;
	let start!: () => void;
	const ready = new Promise<void>((r) => {
		start = r;
	});
	const first = c.act(a.lease, async (signal) => {
		start();
		await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
		await delay(10);
		firstEnded = true;
	});
	const failed = first.catch((e: Error) => e);
	await ready;
	c.releaseAgent(a.lease);
	const b = c.acquire("B");
	await c.act(b.lease, async () => {
		expect(firstEnded).toBe(true);
	});
	expect(await failed).toBeInstanceOf(Error);
	c.close();
});
