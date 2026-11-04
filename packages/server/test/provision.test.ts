import { describe, expect, it, test } from "bun:test";
import { buildCloudInit, orderableServerTypes } from "../src/provision";

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

	test("without an auth key, installs Tailscale but leaves joining to the user's approval", () => {
		const yaml = buildCloudInit({ hostname: "box1", sshPublicKey: KEY });
		expect(yaml).toContain("curl -fsSL https://tailscale.com/install.sh | sh");
		expect(yaml).not.toContain("tailscale up");
		expect(yaml).toContain(KEY);
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

describe("orderableServerTypes", () => {
	// Shaped as Hetzner's GET /server_types answers (hcloud-go schema.ServerType).
	const deprecated = {
		announced: "2025-10-16T00:00:00Z",
		unavailable_after: "2026-01-01T00:00:00Z",
	};
	const types = [
		{
			name: "cpx31",
			cores: 4,
			memory: 8,
			cpu_type: "shared",
			architecture: "x86",
			locations: [
				{ name: "fsn1", available: true, deprecation: deprecated },
				{ name: "ash", available: true, deprecation: null },
			],
		},
		{
			name: "cax11",
			cores: 2,
			memory: 4,
			cpu_type: "shared",
			architecture: "arm",
			locations: [
				{ name: "fsn1", available: true, deprecation: null },
				{ name: "hel1", available: false, deprecation: null },
			],
		},
		{
			name: "cx22",
			cores: 2,
			memory: 4,
			cpu_type: "shared",
			architecture: "x86",
			locations: [{ name: "nbg1", available: true, deprecation: deprecated }],
		},
		{ name: "ccx13", cores: 2, memory: 8, cpu_type: "dedicated", architecture: "x86" },
	];
	const offered = orderableServerTypes(types);

	it("offers a size only where it can be ordered: not deprecated there, not out of stock", () => {
		expect(offered.find((t) => t.slug === "cpx31")?.locations).toEqual(["ash"]);
		expect(offered.find((t) => t.slug === "cax11")?.locations).toEqual(["fsn1"]);
	});

	it("leaves out a size orderable nowhere, and offers one that lists no locations anywhere", () => {
		expect(offered.map((t) => t.slug)).not.toContain("cx22");
		expect(offered.find((t) => t.slug === "ccx13")?.locations).toEqual([]);
	});

	it("lists smallest first and says which are Arm or dedicated", () => {
		expect(offered.map((t) => t.slug)).toEqual(["cax11", "ccx13", "cpx31"]);
		expect(offered[0]?.label).toBe("CAX11 · 2 vCPU / 4 GB (Arm)");
		expect(offered[1]?.label).toBe("CCX13 · 2 vCPU / 8 GB (dedicated)");
		expect(offered[0]?.memory).toBe(4);
	});
});
