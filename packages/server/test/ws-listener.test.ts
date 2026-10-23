import { describe, expect, it } from "bun:test";
import { type AddressInfo, createServer } from "node:net";
import { startWsListener } from "../src/ws-listener";

// The phone's listener is the one part of the engine the desktop never needs, so
// a bind that fails must cost the phone alone. It used to exit the process, which
// on a box with userspace Tailscale (no interface owns the tailnet IP) took every
// engine started with that address down with it, the installer's included.

/** A port that was free a moment ago: bind :0 on loopback, read it, let it go. */
async function freePort(): Promise<number> {
	const srv = createServer();
	await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
	const { port } = srv.address() as AddressInfo;
	await new Promise<void>((resolve) => srv.close(() => resolve()));
	return port;
}

/** Poll until `cond` holds, failing after `ms` rather than hanging the run. */
async function waitFor(cond: () => boolean, ms = 3_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`condition not met within ${ms} ms`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

describe("the phone's WS listener", () => {
	it("an address this box doesn't have costs the listener, not the process", async () => {
		const logs: string[] = [];
		const listener = startWsListener({
			host: "192.0.2.1", // TEST-NET-1, on no interface
			port: await freePort(),
			retryMs: [10],
			onConnection: () => {},
			log: (l) => logs.push(l),
		});
		// Room for several 10 ms retries, each failing the same way. The outage is
		// logged once, not once per attempt.
		await new Promise((r) => setTimeout(r, 150));
		expect(logs.filter((l) => /WS listener error/.test(l))).toHaveLength(1);
		listener.close();
	});

	it("comes up once the port frees, and serves", async () => {
		// Something else holds the port, so the first attempts fail with it in use.
		const blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
		const { port } = blocker.address() as AddressInfo;

		const logs: string[] = [];
		let connections = 0;
		const listener = startWsListener({
			host: "127.0.0.1",
			port,
			retryMs: [20],
			onConnection: () => {
				connections++;
			},
			log: (l) => logs.push(l),
		});
		await waitFor(() => logs.some((l) => /WS listener error/.test(l)));

		// The port frees up and a retry takes it, with nothing restarted.
		await new Promise<void>((resolve) => blocker.close(() => resolve()));
		await waitFor(() => logs.some((l) => l.includes(`listening on ws://127.0.0.1:${port}`)));

		const client = new WebSocket(`ws://127.0.0.1:${port}`);
		await new Promise<void>((resolve, reject) => {
			client.addEventListener("open", () => resolve());
			client.addEventListener("error", () => reject(new Error("client could not connect")));
		});
		await waitFor(() => connections > 0);
		expect(connections).toBe(1);

		client.close();
		listener.close();
	});
});
