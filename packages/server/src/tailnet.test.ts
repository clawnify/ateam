// Reaching other boxes from a box whose Tailscale runs in userspace mode (boxd):
// which hosts need `tailscale nc`, the stream it gives, and the address hello reports.
import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { networkInterfaces } from "node:os";
import { PassThrough } from "node:stream";
import { isTailnetHost, needsTailscaleNc, reachableWsAddr, tailscaleNc } from "./tailnet";

type Ifaces = ReturnType<typeof networkInterfaces>;
const iface = (address: string, family: "IPv4" | "IPv6" = "IPv4") => ({
	address,
	family,
	internal: false,
	netmask: "",
	mac: "",
	cidr: null,
	...(family === "IPv6" ? { scopeid: 0 } : {}),
});
// A boxd box: loopback and its provider's network, no interface with a tailnet address.
const userspace = { lo: [iface("127.0.0.1")], eth0: [iface("10.0.0.5")] } as unknown as Ifaces;
// Tailscale in its usual mode: tailscale0 carries the tailnet address.
const tun = { ...userspace, tailscale0: [iface("100.94.46.10")] } as unknown as Ifaces;

describe("isTailnetHost", () => {
	it("knows tailnet addresses and names", () => {
		for (const h of ["100.64.0.1", "100.81.40.73", "100.127.255.254", "fd7a:115c:a1e0::1"]) {
			expect(isTailnetHost(h)).toBe(true);
		}
		expect(isTailnetHost("[fd7a:115c:a1e0:ab12::5]")).toBe(true);
		expect(isTailnetHost("box.tail1234.ts.net")).toBe(true);
		expect(isTailnetHost("box.tail1234.ts.net.")).toBe(true);
	});

	it("leaves everything else alone", () => {
		for (const h of [
			"100.63.255.255",
			"100.128.0.1",
			"127.0.0.1",
			"10.0.0.5",
			"example.com",
			"::1",
		]) {
			expect(isTailnetHost(h)).toBe(false);
		}
	});
});

describe("needsTailscaleNc", () => {
	it("is needed for a tailnet host only when no interface here carries a tailnet address", () => {
		expect(needsTailscaleNc("100.94.46.10", userspace)).toBe(true);
		expect(needsTailscaleNc("100.94.46.10", tun)).toBe(false);
		expect(needsTailscaleNc("10.0.0.7", userspace)).toBe(false);
		expect(needsTailscaleNc("example.com", userspace)).toBe(false);
	});
});

// A stand-in for the `tailscale nc` child: pipes, kill(), exit.
function fakeNc() {
	const child = new EventEmitter() as EventEmitter & {
		stdin: PassThrough;
		stdout: PassThrough;
		stderr: PassThrough;
		exitCode: number | null;
		killed: boolean;
		kill: () => boolean;
	};
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.exitCode = null;
	child.killed = false;
	child.kill = () => {
		child.killed = true;
		return true;
	};
	return child;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("tailscaleNc", () => {
	it("runs `tailscale nc` and carries bytes both ways", async () => {
		const child = fakeNc();
		let args: string[] = [];
		const stream = tailscaleNc("[fd7a:115c:a1e0::5]", 8787, {
			spawn: (a) => {
				args = a;
				return child as unknown as ChildProcess;
			},
		});
		expect(args).toEqual(["nc", "fd7a:115c:a1e0::5", "8787"]);
		const sent: string[] = [];
		child.stdin.on("data", (b: Buffer) => sent.push(b.toString()));
		stream.write("GET / HTTP/1.1\r\n\r\n");
		const got: string[] = [];
		stream.on("data", (b: Buffer) => got.push(b.toString()));
		child.stdout.write("HTTP/1.1 101 Switching Protocols\r\n\r\n");
		await tick();
		expect(sent.join("")).toBe("GET / HTTP/1.1\r\n\r\n");
		expect(got.join("")).toBe("HTTP/1.1 101 Switching Protocols\r\n\r\n");
	});

	it("passes on what nc says and fails the stream with it when nc gives up", async () => {
		const said: string[] = [];
		const errors: string[] = [];
		const child = fakeNc();
		const stream = tailscaleNc("100.94.46.10", 8787, {
			spawn: () => child as unknown as ChildProcess,
			onStderr: (line) => said.push(line),
		});
		stream.on("error", (e) => errors.push(e.message));
		child.stderr.write("dial tcp 100.94.46.10:8787: connect: connection refused\npartial");
		await tick();
		child.exitCode = 1;
		child.emit("exit", 1, null);
		await tick();
		expect(said).toEqual(["dial tcp 100.94.46.10:8787: connect: connection refused", "partial"]);
		expect(errors).toEqual(["tailscale nc exited with 1: partial"]);
		expect(stream.destroyed).toBe(true);
		expect(child.killed).toBe(false); // it had exited on its own
	});

	it("ends with nc's output after a clean exit, and stops nc when closed first", async () => {
		const child = fakeNc();
		const stream = tailscaleNc("100.94.46.10", 8787, {
			spawn: () => child as unknown as ChildProcess,
		});
		let ended = false;
		stream.on("end", () => {
			ended = true;
		});
		stream.resume();
		child.stdout.end();
		child.exitCode = 0;
		child.emit("exit", 0, null);
		await tick();
		expect(ended).toBe(true);

		const other = fakeNc();
		const second = tailscaleNc("100.94.46.10", 8787, {
			spawn: () => other as unknown as ChildProcess,
		});
		second.on("error", () => {}); // closing a live stream aborts it
		second.destroy();
		await tick();
		expect(other.killed).toBe(true);
	});

	it("fails the stream when tailscale can't be started", async () => {
		const child = fakeNc();
		const stream = tailscaleNc("100.94.46.10", 8787, {
			spawn: () => child as unknown as ChildProcess,
		});
		const errors: string[] = [];
		stream.on("error", (e) => errors.push(e.message));
		child.emit("error", new Error("spawn tailscale ENOENT"));
		await tick();
		expect(errors).toEqual(["tailscale nc: spawn tailscale ENOENT"]);
	});
});

describe("reachableWsAddr", () => {
	// `tailscale serve status --json` and `tailscale ip -4` as boxd answers them.
	const tailscale =
		(serve: unknown, ip = "100.81.40.73\n") =>
		async (args: string[]) =>
			args[0] === "serve" ? (serve === null ? null : JSON.stringify(serve)) : ip;
	const forward = { TCP: { "8787": { TCPForward: "localhost:8787" } } };

	it("keeps an address other machines can reach", async () => {
		let asked = false;
		const run = async () => {
			asked = true;
			return null;
		};
		expect(await reachableWsAddr("100.94.46.10:8787", run)).toBe("100.94.46.10:8787");
		expect(asked).toBe(false);
		expect(await reachableWsAddr(null, run)).toBe(null);
	});

	it("reports the tailnet address Serve forwards to a loopback listener", async () => {
		expect(await reachableWsAddr("127.0.0.1:8787", tailscale(forward))).toBe("100.81.40.73:8787");
		const elsewhere = { TCP: { "443": { TCPForward: "127.0.0.1:8787" } } };
		expect(await reachableWsAddr("127.0.0.1:8787", tailscale(elsewhere))).toBe("100.81.40.73:443");
	});

	it("keeps the loopback address when nothing forwards to it", async () => {
		expect(await reachableWsAddr("127.0.0.1:8787", tailscale(null))).toBe("127.0.0.1:8787");
		expect(await reachableWsAddr("127.0.0.1:8787", tailscale({}))).toBe("127.0.0.1:8787");
		const other = { TCP: { "8787": { TCPForward: "localhost:3000" } } };
		expect(await reachableWsAddr("127.0.0.1:8787", tailscale(other))).toBe("127.0.0.1:8787");
		const garbled = async (args: string[]) => (args[0] === "serve" ? "{not json" : "100.81.40.73");
		expect(await reachableWsAddr("127.0.0.1:8787", garbled)).toBe("127.0.0.1:8787");
		expect(await reachableWsAddr("127.0.0.1:8787", tailscale(forward, "\n"))).toBe(
			"127.0.0.1:8787",
		);
	});
});
