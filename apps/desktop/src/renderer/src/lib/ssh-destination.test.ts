import { describe, expect, it } from "bun:test";
import { sshDestination } from "./ssh-destination";

describe("sshDestination", () => {
	it("takes the command a provider prints, without its ssh", () => {
		// What exe.dev printed for a new VM, pasted as is (2026-11-04).
		expect(sshDestination("ssh ateam-exe.exe.xyz")).toEqual({ dest: "ateam-exe.exe.xyz" });
		expect(sshDestination("  ssh   mybox.boxd \n")).toEqual({ dest: "mybox.boxd" });
	});

	it("takes an alias or user@host as typed", () => {
		expect(sshDestination("mybox.sprite")).toEqual({ dest: "mybox.sprite" });
		expect(sshDestination("you@203.0.113.5")).toEqual({ dest: "you@203.0.113.5" });
	});

	it("says what to type for anything that isn't one destination", () => {
		for (const typed of ["ssh -p 2222 mybox", "my box", "-oProxyCommand=x", "ssh", "   "]) {
			expect("problem" in sshDestination(typed)).toBe(true);
		}
	});
});
