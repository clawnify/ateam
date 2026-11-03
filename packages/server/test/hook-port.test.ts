import { afterEach, describe, expect, it } from "bun:test";
import net from "node:net";
import { FRESH_PORT_MAX, FRESH_PORT_MIN, HookServer } from "../src/hooks/hook-server";

/**
 * Agents read the hook port once, at launch, so an engine restart that lands on
 * a different port strands every agent that outlived it (#400). These pin how
 * `start()` keeps the saved port and where it goes when it can't.
 */

const servers: HookServer[] = [];
const holders: net.Server[] = [];

afterEach(() => {
	for (const s of servers.splice(0)) s.stop();
	for (const h of holders.splice(0)) h.close();
});

/** Another socket listening on 127.0.0.1 (port 0 = any free one). */
async function hold(port = 0): Promise<{ port: number; release: () => Promise<void> }> {
	const srv = net.createServer();
	holders.push(srv);
	await new Promise<void>((resolve, reject) => {
		srv.once("error", reject);
		srv.listen(port, "127.0.0.1", () => resolve());
	});
	const addr = srv.address();
	return {
		port: typeof addr === "object" && addr ? addr.port : 0,
		release: () => new Promise<void>((resolve) => srv.close(() => resolve())),
	};
}

function hookServer(): HookServer {
	const s = new HookServer();
	servers.push(s);
	return s;
}

describe("HookServer.start port choice", () => {
	it("binds the saved port once its holder lets go within the retry window", async () => {
		const held = await hold();
		const lines: string[] = [];
		const started = hookServer().start(held.port, { retryForMs: 3_000, log: (l) => lines.push(l) });
		await new Promise((r) => setTimeout(r, 600));
		await held.release();
		expect(await started).toBe(held.port);
		expect(lines).toEqual([]);
	});

	it("keeps a free saved port even inside the OS ephemeral range", async () => {
		// Port 0 hands out an ephemeral port: exactly the kind older builds saved.
		const held = await hold();
		await held.release();
		const lines: string[] = [];
		expect(await hookServer().start(held.port, { log: (l) => lines.push(l) })).toBe(held.port);
		expect(lines).toEqual([]);
	});

	it("moves below the ephemeral ranges, and says so, when the saved port stays busy", async () => {
		const held = await hold();
		const lines: string[] = [];
		const t0 = Date.now();
		const port = await hookServer().start(held.port, {
			retryForMs: 600,
			log: (l) => lines.push(l),
		});
		expect(Date.now() - t0).toBeGreaterThanOrEqual(600);
		expect(port).not.toBe(held.port);
		expect(port).toBeGreaterThanOrEqual(FRESH_PORT_MIN);
		expect(port).toBeLessThanOrEqual(FRESH_PORT_MAX);
		expect(FRESH_PORT_MAX).toBeLessThan(32_768);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(String(held.port));
		expect(lines[0]).toContain(String(port));
		expect(lines[0]).toContain("EADDRINUSE");
	});

	it("binds below the ephemeral ranges with no saved port", async () => {
		const lines: string[] = [];
		for (const preferred of [undefined, 0]) {
			const port = await hookServer().start(preferred, { log: (l) => lines.push(l) });
			expect(port).toBeGreaterThanOrEqual(FRESH_PORT_MIN);
			expect(port).toBeLessThanOrEqual(FRESH_PORT_MAX);
		}
		expect(lines).toEqual([]);
	});

	it("serves on the port it reports", async () => {
		const s = hookServer();
		const port = await s.start();
		const res = await fetch(`http://127.0.0.1:${port}/nope`);
		expect(res.status).toBe(404);
	});
});
