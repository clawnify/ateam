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

test("confirming the current human owner preserves held keys and buttons", async () => {
	const c = new DesktopControl();
	let revoked = 0;
	c.onRevoke = () => {
		revoked++;
	};
	await c.takeOver("A");
	const first = revoked;
	await c.takeOver("A");
	expect(revoked).toBe(first);
	expect(c.canInput("A")).toBe(true);
	await c.takeOver("B");
	expect(revoked).toBe(first + 1);
	expect(c.canInput("A")).toBe(false);
	c.close();
});

test("a person's control lapses without input, and their input keeps it", async () => {
	// Wide margins: a loaded CI runner can fire timers tens of ms late.
	const c = new DesktopControl(10_000, 300);
	await c.takeOver("A");
	expect(c.status()?.expiresAt).toBeNumber();
	await delay(100);
	c.viewerInput("A");
	c.viewerInput("B"); // Another viewer's input never extends A.
	await delay(250); // Past the first deadline (300), inside the moved one (400).
	expect(c.status()?.kind).toBe("human");
	expect(c.canInput("A")).toBe(true);
	await delay(200);
	expect(c.status()).toBeNull(); // status() expires an overdue lease itself.
	expect(c.canInput("A")).toBe(false);
	expect(c.acquire("agent").lease).toBeTruthy();
	c.close();
});

test("a lapsed person takes control back with their next gesture", async () => {
	const c = new DesktopControl(10_000, 20);
	await c.takeOver("A");
	await delay(40);
	expect(c.status()).toBeNull();
	expect(c.canInput("A")).toBe(false);
	const { lease } = c.acquire("agent");
	await c.takeOver("A");
	expect(c.canInput("A")).toBe(true);
	await expect(c.act(lease, async () => {})).rejects.toThrow("No valid");
	c.close();
});

test("a running action outlives its lease TTL, and the lease expires once it ends", async () => {
	const c = new DesktopControl(30);
	const { lease } = c.acquire("agent");
	await c.act(lease, () => delay(80));
	expect(() => c.acquire("other")).toThrow("agent"); // Renewed when the action ended.
	const failed = c.act(lease, async () => {
		await delay(80);
		throw new Error("xdotool failed");
	});
	await expect(failed).rejects.toThrow("xdotool failed");
	await delay(10);
	expect(c.status()).toBeNull(); // Overdue without renewal: expires at once.
	c.close();
});
