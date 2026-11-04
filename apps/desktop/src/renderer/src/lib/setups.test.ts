import { describe, expect, it } from "bun:test";
import type { HostStatus } from "../../../shared/host";
import { dismissSetup, setupsNow, startSetup } from "./setups";

const status: HostStatus = {
	mode: "remote",
	alias: "box",
	info: { protocolVersion: 30, agents: [] },
};
const find = (dest: string) => setupsNow().find((s) => s.dest === dest);

describe("box set-ups", () => {
	it("is running with its log, then done, however the screen that started it went", async () => {
		let finish: (s: HostStatus) => void = () => {};
		let say: (chunk: string) => void = () => {};
		const done = startSetup("a.example", (onLog) => {
			say = onLog;
			return new Promise((resolve) => {
				finish = resolve;
			});
		});
		say("==> [1/7] locate a Node\n");
		expect(find("a.example")).toMatchObject({ state: "running", log: "==> [1/7] locate a Node\n" });
		finish(status);
		await done;
		expect(find("a.example")?.state).toBe("done");
	});

	it("hands back the set-up already running for the same box", async () => {
		let finish: (s: HostStatus) => void = () => {};
		let runs = 0;
		const run = () => {
			runs++;
			return new Promise<HostStatus>((resolve) => {
				finish = resolve;
			});
		};
		const first = startSetup("b.example", run);
		const second = startSetup("b.example", run);
		expect(second).toBe(first);
		finish(status);
		await first;
		expect(runs).toBe(1);
	});

	it("keeps why it failed, without Electron's IPC wording, until dismissed", async () => {
		const failed = startSetup("c.example", async () => {
			throw new Error(
				"Error invoking remote method 'host:install': Error: Setup of \"c.example\" failed: ssh exited 255.",
			);
		});
		await failed.catch(() => {});
		expect(find("c.example")).toMatchObject({
			state: "failed",
			error: 'Setup of "c.example" failed: ssh exited 255.',
		});
		dismissSetup("c.example");
		expect(find("c.example")).toBeUndefined();
	});
});
