import { describe, expect, test } from "bun:test";
import { buildCloudInit } from "../src/provision";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTKEYtestkeytestkeytestkeytestkey ateam";
const AUTHKEY = "tskey-auth-abc123DEF-ghiJKL456";

describe("buildCloudInit", () => {
	test("emits a cloud-config that creates the ateam user and joins Tailscale with SSH", () => {
		const yaml = buildCloudInit({
			hostname: "my-box",
			sshPublicKey: KEY,
			tailscaleAuthKey: AUTHKEY,
		});
		expect(yaml.startsWith("#cloud-config")).toBe(true);
		expect(yaml).toContain("name: ateam");
		expect(yaml).toContain(`- ${KEY}`);
		// Non-interactive Tailscale join, with SSH so the tailnet is the auth boundary.
		expect(yaml).toContain(
			`tailscale up --ssh --authkey=${AUTHKEY} --hostname=my-box --operator=ateam`,
		);
		// The ateam engine is installed AFTERWARD over SSH — cloud-init must not fetch it
		// (the clawnify installer). Note Tailscale's own installer is also `install.sh`.
		expect(yaml).not.toContain("clawnify");
	});

	test("rejects a bad box name (would break the DNS label / shell line)", () => {
		expect(() =>
			buildCloudInit({ hostname: "bad name!", sshPublicKey: KEY, tailscaleAuthKey: AUTHKEY }),
		).toThrow(/invalid box name/);
	});

	test("rejects a non-Tailscale auth key", () => {
		expect(() =>
			buildCloudInit({ hostname: "b", sshPublicKey: KEY, tailscaleAuthKey: "nope" }),
		).toThrow(/Tailscale auth key/);
	});

	test("rejects a value that isn't an SSH public key", () => {
		expect(() =>
			buildCloudInit({ hostname: "b", sshPublicKey: "rm -rf /", tailscaleAuthKey: AUTHKEY }),
		).toThrow(/SSH public key/);
	});
});
