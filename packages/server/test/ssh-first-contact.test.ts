// Setting a box up over SSH from the desktop: the first contact with a host ssh has
// never seen, and ssh's own reasons for failing, in words. Every ssh line below is
// OpenSSH_10.2p1's own text on macOS (2026-11-02), run in batch mode the way
// sshExec runs it, with user names and paths replaced.
import { describe, expect, test } from "bun:test";
import {
	describeSshFailure,
	firstContactFlags,
	installerFailure,
	sshClientTransport,
} from "../src/transport/ssh";

/** A stand-in for `ssh -G <dest>` that prints `stricthostkeychecking <value>`. */
const reports = (value: string) => async () => `batchmode no\nstricthostkeychecking ${value}\n`;

describe("the first contact with a box", () => {
	test("while ssh would ask, a new host key is accepted", async () => {
		expect(await firstContactFlags("mybox.exe.xyz", reports("ask"))).toEqual([
			"-o",
			"StrictHostKeyChecking=accept-new",
		]);
	});

	test("a value the user set in their ssh config is left alone", async () => {
		// `ssh -G` reports StrictHostKeyChecking yes as true, and no or off as false.
		for (const value of ["true", "false", "accept-new"]) {
			expect(await firstContactFlags("mybox.exe.xyz", reports(value))).toEqual([]);
		}
	});

	test("when ssh can't report its options, nothing is added", async () => {
		expect(await firstContactFlags("mybox.exe.xyz", async () => "")).toEqual([]);
	});
});

describe("ssh's reason for failing, in words", () => {
	test("an unknown host key, in batch mode", () => {
		expect(describeSshFailure("Host key verification failed.\n")).toContain(
			"Connect once from a terminal",
		);
	});

	test("an unknown host key under StrictHostKeyChecking yes, which a terminal refuses too", () => {
		const out =
			"No ED25519 host key is known for github.com and you have requested strict checking.\nHost key verification failed.\n";
		const said = describeSshFailure(out);
		expect(said).toContain("StrictHostKeyChecking yes");
		expect(said).not.toContain("terminal");
	});

	test("a host key that changed is told apart from an unknown one", () => {
		const out = [
			"@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
			"@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
			"@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
			"IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!",
			"Offending RSA key in /Users/me/.ssh/known_hosts:1",
			"Host key for github.com has changed and you have requested strict checking.",
			"Host key verification failed.",
		].join("\n");
		expect(describeSshFailure(out)).toContain("host key has changed");
		expect(describeSshFailure(out)).toContain("line 1 of /Users/me/.ssh/known_hosts");
	});

	test("no key the box accepts, including a key with a passphrase it can't use", () => {
		for (const out of [
			// After accept-new took the host key, the login itself failed.
			"Warning: Permanently added 'github.com' (ED25519) to the list of known hosts.\ngit@github.com: Permission denied (publickey).\n",
			// exe.dev, with only passphrase-protected keys on the Mac.
			"me@exe.dev: Permission denied (publickey,keyboard-interactive).\n",
		]) {
			expect(describeSshFailure(out)).toContain("didn't accept a key");
		}
	});

	test("a name that doesn't resolve", () => {
		const out =
			"ssh: Could not resolve hostname nonexistent-host.invalid: nodename nor servname provided, or not known\n";
		expect(describeSshFailure(out)).toContain("couldn't find a box by that name");
	});

	test("a destination that isn't a host name, such as a pasted ssh command", () => {
		// What ssh said for "ssh ateam-exe.exe.xyz" typed into Set up (2026-11-04).
		expect(describeSshFailure("hostname contains invalid characters\n")).toContain(
			"give just its name",
		);
	});

	test("nothing answering, refused or timed out", () => {
		for (const out of [
			"ssh: connect to host 127.0.0.1 port 1: Connection refused\n",
			"ssh: connect to host 10.255.255.1 port 22: Operation timed out\n",
		]) {
			expect(describeSshFailure(out)).toContain("Nothing answered");
		}
	});

	test("the installer's own failures are not mistaken for ssh's", () => {
		const out =
			"[ok] node 22\ncurl: (28) Operation timed out after 30001 milliseconds\nchmod: /usr/local/bin/ateam: Permission denied\n";
		expect(describeSshFailure(out)).toBeNull();
	});
});

describe("the installer's reason for stopping, in its words", () => {
	test("the line it died with, the last one when there are several", () => {
		const out =
			"==> join your tailnet (--tailscale)\n\n!! first\n\n!! --tailscale needs passwordless sudo, to install and run Tailscale\n";
		expect(installerFailure(out)).toBe(
			"--tailscale needs passwordless sudo, to install and run Tailscale",
		);
	});

	test("nothing when it didn't die that way", () => {
		expect(installerFailure("Permission denied (publickey).\n")).toBeNull();
		expect(installerFailure("    [--] tailscale: !! not a die line\n")).toBeNull();
	});
});

describe("a connection ssh refuses", () => {
	test("keeps what ssh said, so the reason can be told", async () => {
		// .invalid never resolves (RFC 2606), so ssh gives up at once and says why.
		const client = sshClientTransport("box.invalid", ["true"], {
			sshFlags: ["-F", "/dev/null", "-o", "BatchMode=yes"],
		});
		const said = await client.stderr(10_000);
		client.close();
		expect(said).toContain("box.invalid");
		expect(describeSshFailure(said)).toContain("couldn't find a box");
	});
});
