import { describe, expect, test } from "bun:test";
import { createRpcClient } from "@ateam/protocol";
import type { SSHNative } from "../modules/expo-ssh/src";
import { sshTransport } from "./ssh-transport";

type NativeEvent = { id: string; line?: string; message?: string };
function harness() {
	const listeners = new Map<string, Set<(e: NativeEvent) => void>>();
	const writes: string[] = [];
	let closes = 0;
	const native = {
		addListener(event: string, handler: (e: NativeEvent) => void) {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			set.add(handler);
			return { remove: () => set.delete(handler) };
		},
		attach: async () => {},
		close: async () => {
			closes++;
		},
		write: async (_id: string, line: string) => {
			writes.push(line);
		},
		forward: async (_id: string, port: number) => {
			expect(port).toBe(3000);
			return 49152;
		},
	} as unknown as SSHNative;
	return {
		native,
		writes,
		closes: () => closes,
		emit: (event: string, e: NativeEvent) => {
			for (const f of listeners.get(event) ?? []) f(e);
		},
		count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
	};
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("native SSH transport", () => {
	test("preserves frame boundaries, ignores other sessions, and routes RPC replies", async () => {
		const h = harness(),
			client = sshTransport(h.native, "a");
		await client.start();
		const rpc = createRpcClient(client.transport);
		const reply = rpc.call("system:hello");
		await tick();
		const sent = JSON.parse(h.writes[0] ?? "null");
		expect(sent.method).toBe("system:hello");
		h.emit("line", { id: "other", line: "bad" });
		h.emit("line", {
			id: "a",
			line: JSON.stringify({ t: "res", id: sent.id, ok: true, result: "€" }),
		});
		expect(await reply).toBe("€");
		expect(await client.httpUrl(3000)).toBe("http://127.0.0.1:49152");
		client.close();
		expect(h.count()).toBe(0);
	});
	test("subscribes before attach and buffers early frames", async () => {
		const h = harness(),
			client = sshTransport(h.native, "a");
		h.native.attach = async () => {
			h.emit("line", { id: "a", line: '{"t":"evt","event":"ready","payload":1}' });
		};
		await client.start();
		const frames: unknown[] = [];
		client.transport.onFrame((f) => frames.push(f));
		expect(frames).toEqual([{ t: "evt", event: "ready", payload: 1 }]);
		client.close();
	});
	test("orders bridge writes even when one takes longer", async () => {
		const h = harness(),
			client = sshTransport(h.native, "a");
		let finish!: () => void;
		h.native.write = async (_id, line) => {
			h.writes.push(line);
			if (h.writes.length === 1)
				await new Promise<void>((r) => {
					finish = r;
				});
		};
		const rpc = createRpcClient(client.transport);
		const a = rpc.call("first").catch(() => {}),
			b = rpc.call("second").catch(() => {});
		await tick();
		expect(h.writes.map((s) => JSON.parse(s).method)).toEqual(["first"]);
		finish();
		await tick();
		expect(h.writes.map((s) => JSON.parse(s).method)).toEqual(["first", "second"]);
		client.close();
		await Promise.all([a, b]);
	});
	test("rejects malformed protocol envelopes before dispatch", async () => {
		for (const frame of [
			{ t: "res", id: "1", ok: true },
			{ t: "res", id: 1, ok: "yes" },
			{ t: "res", id: 1, ok: false, error: {} },
			{ t: "evt", event: 42 },
		]) {
			const h = harness(),
				client = sshTransport(h.native, "a");
			h.emit("line", { id: "a", line: JSON.stringify(frame) });
			await expect(client.start()).rejects.toThrow("Invalid data");
			expect(h.closes()).toBe(1);
		}
	});
	test("bounds early frames by both count and total size", async () => {
		for (const payload of ["small", "x".repeat(1024 * 1024)]) {
			const h = harness(),
				client = sshTransport(h.native, "a");
			const line = JSON.stringify({ t: "evt", event: "ready", payload });
			for (let n = 0; n < (payload === "small" ? 65 : 8); n++) h.emit("line", { id: "a", line });
			await expect(client.start()).rejects.toThrow("Too many SSH frames");
			expect(h.closes()).toBe(1);
			expect(h.count()).toBe(0);
		}
	});
	test("an early remote exit rejects start and closes only once", async () => {
		const h = harness(),
			client = sshTransport(h.native, "a");
		h.native.attach = async () => {
			h.emit("closed", { id: "a", message: "remote command failed" });
		};
		await expect(client.start()).rejects.toThrow("remote command failed");
		client.close();
		expect(h.closes()).toBe(1);
		expect(h.count()).toBe(0);
	});
	test("bad stdout or a write failure rejects in-flight RPC and cleans up listeners", async () => {
		for (const kind of ["stdout", "write"]) {
			const h = harness(),
				client = sshTransport(h.native, "a");
			if (kind === "write")
				h.native.write = async () => {
					throw new Error("socket lost");
				};
			const rpc = createRpcClient(client.transport);
			const pending = rpc.call("first").catch((e: Error) => e.message);
			if (kind === "stdout") h.emit("line", { id: "a", line: "shell startup banner" });
			expect(await pending).toBe("RPC connection closed");
			expect(h.count()).toBe(0);
			expect(h.closes()).toBe(1);
		}
	});
});
