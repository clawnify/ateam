import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyClient } from "../src/pty/pty-client";

// A daemon stand-in that says hello late, or never. Connected is not attached:
// until the hello lists the terminals still alive, has() answers false for all of
// them, and an engine that served calls then read live sessions as gone.
const servers: Server[] = [];
let n = 0;
afterEach(() => {
	for (const s of servers.splice(0)) s.close();
});
async function slowDaemon(helloAfterMs: number | null, terminals: string[]) {
	const sock = join(tmpdir(), `ateam-ptya-${process.pid}-${n++}.sock`);
	const server = createServer((c) => {
		if (helloAfterMs === null) return;
		setTimeout(() => {
			const list = terminals.map((terminalId) => ({ terminalId, cwd: "/", agentId: "shell" }));
			c.write(`${JSON.stringify({ t: "hello", terminals: list })}\n`);
		}, helloAfterMs);
	});
	servers.push(server);
	await new Promise<void>((r) => server.listen(sock, () => r()));
	return sock;
}

describe("PtyClient connect", () => {
	test("resolves only once the daemon's hello has listed its live terminals", async () => {
		const c = new PtyClient(
			import.meta.path,
			await slowDaemon(150, ["box-shell"]),
			"/usr/bin/false",
		);
		await c.connect();
		expect(c.has("box-shell")).toBe(true);
		c.disconnect();
	});

	test("a daemon that never says hello holds connect only for the timeout", async () => {
		const sock = await slowDaemon(null, ["box-shell"]);
		const c = new PtyClient(import.meta.path, sock, "/usr/bin/false", 100);
		const started = Date.now();
		await c.connect();
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(c.has("box-shell")).toBe(false);
		c.disconnect();
	});
});
