import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { type AddressInfo, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRelay, relayHost } from "../src/box-relay";

describe("box relay: which host", () => {
	const empty = () => mkdtempSync(join(tmpdir(), "relay-"));

	test("none without a tailnet address", () => {
		expect(relayHost({}, empty())).toBeNull();
	});
	test("the env's host", () => {
		expect(relayHost({ ATEAM_WS_ADDR: "100.72.63.61:8787" }, empty())).toBe("100.72.63.61");
	});
	test("the installer's ws-addr file when the env has none", () => {
		const dir = empty();
		writeFileSync(join(dir, "ws-addr"), "100.1.2.3:8787\n");
		expect(relayHost({}, dir)).toBe("100.1.2.3");
	});
	test("none for loopback, which the service already binds", () => {
		expect(relayHost({ ATEAM_WS_ADDR: "127.0.0.1:8787" }, empty())).toBeNull();
	});
});

describe("box relay: forwarding", () => {
	test("bytes sent to host:port come back from 127.0.0.1:port", async () => {
		// An echo service on loopback, relayed from IPv6 loopback on the same port:
		// two addresses this machine owns, as a tailnet IP and loopback are on a box.
		const upstream = createServer((s) => s.pipe(s));
		await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
		const port = (upstream.address() as AddressInfo).port;
		await ensureRelay("::1", port, () => {});
		const reply = await new Promise<string>((resolve, reject) => {
			const c = connect({ host: "::1", port }, () => c.write("ping"));
			c.on("data", (d) => {
				resolve(d.toString());
				c.end();
			});
			c.on("error", reject);
		});
		expect(reply).toBe("ping");
		upstream.close();
	});

	test("an address this machine doesn't own is logged, not thrown", async () => {
		const lines: string[] = [];
		await ensureRelay("192.0.2.1", 6080, (l) => lines.push(l));
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("ssh clients are unaffected");
	});
});
