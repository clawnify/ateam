import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyClient } from "../src/pty/pty-client";

// A daemon stand-in that speaks the newline-JSON protocol: sends `hello` with
// the build it claims to run and the terminals it holds, records what it is
// asked, and can emit an `exit` for a terminal. The client under test spawns
// nothing: the "daemon file" it hashes is this test file itself, so the build
// an up-to-date daemon would report is known.
const OWN_DAEMON = import.meta.path;
const servers: Server[] = [];
let n = 0;

afterEach(() => {
	for (const s of servers.splice(0)) s.close();
});

function fakeDaemon(build: string | undefined, terminals: string[]) {
	const sock = join(tmpdir(), `ateam-ptyc-${process.pid}-${n++}.sock`);
	const asked: string[] = [];
	let conn: Socket | null = null;
	const server = createServer((c) => {
		conn = c;
		c.write(
			`${JSON.stringify({ t: "hello", ...(build === undefined ? {} : { build }), terminals: terminals.map((terminalId) => ({ terminalId, cwd: "/", agentId: "shell" })) })}\n`,
		);
		c.on("data", (chunk) => {
			for (const line of chunk.toString().split("\n")) {
				if (!line.trim()) continue;
				const m = JSON.parse(line);
				asked.push(m.t);
				if (m.t === "snapshot") {
					c.write(
						`${JSON.stringify({ t: "snapshot", id: m.id, data: Buffer.from("\x1b[?1003hscreen").toString("base64"), seq: 1 })}\n`,
					);
				}
			}
		});
	});
	servers.push(server);
	const listening = new Promise<void>((r) => server.listen(sock, () => r()));
	return {
		sock,
		asked,
		listening,
		exit: (terminalId: string) =>
			conn?.write(`${JSON.stringify({ t: "exit", terminalId, exitCode: 0 })}\n`),
	};
}

const ownBuild = () => createHash("sha1").update(readFileSync(OWN_DAEMON)).digest("hex");
const tick = () => new Promise((r) => setTimeout(r, 60));

describe("PtyClient daemon build check", () => {
	test("an idle daemon running other code is told to shut down", async () => {
		const d = fakeDaemon("stale-build", []);
		await d.listening;
		const c = new PtyClient(OWN_DAEMON, d.sock, "/usr/bin/false");
		await c.connect();
		await tick();
		expect(d.asked).toEqual(["shutdown"]);
		c.disconnect();
	});

	test("a daemon holding terminals is left alone until the last one exits", async () => {
		const d = fakeDaemon("stale-build", ["t1", "t2"]);
		await d.listening;
		const c = new PtyClient(OWN_DAEMON, d.sock, "/usr/bin/false");
		await c.connect();
		await tick();
		expect(d.asked).toEqual([]);
		d.exit("t1");
		await tick();
		expect(d.asked).toEqual([]);
		d.exit("t2");
		await tick();
		expect(d.asked).toEqual(["shutdown"]);
		c.disconnect();
	});

	test("a daemon on the same build, or one too old to say, is never restarted", async () => {
		for (const build of [ownBuild(), undefined]) {
			const d = fakeDaemon(build, []);
			await d.listening;
			const c = new PtyClient(OWN_DAEMON, d.sock, "/usr/bin/false");
			await c.connect();
			await tick();
			expect(d.asked).toEqual([]);
			c.disconnect();
		}
	});

	test("snapshots from an old daemon get the SGR mouse encoding appended", async () => {
		const d = fakeDaemon(undefined, ["t1"]);
		await d.listening;
		const c = new PtyClient(OWN_DAEMON, d.sock, "/usr/bin/false");
		await c.connect();
		const snap = await c.snapshot("t1");
		expect(snap.data).toBe("\x1b[?1003hscreen\x1b[?1006h");
		c.disconnect();
	});
});
