import { describe, expect, it, test } from "bun:test";
import {
	buildCloudInit,
	hetznerProvider,
	LeftoverAddressesError,
	orderableServerTypes,
} from "./provision";

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
		expect(yaml).toContain(`- ${JSON.stringify(KEY)}`);
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

	const HASH = "a".repeat(64);

	test("for a phone, installs the engine itself and pairs the phone, with no SSH login at all", () => {
		const yaml = buildCloudInit({
			hostname: "my-box",
			tailscaleAuthKey: AUTHKEY,
			install: { pairDevice: { tokenHash: HASH, label: "iPhone" } },
		});
		expect(yaml).not.toContain("ssh_authorized_keys");
		expect(yaml).toContain("ssh_pwauth: false");
		const last = yaml.split("\n").at(-1) ?? "";
		// As the ateam user, after Tailscale is up, the installer's own --tailscale then
		// finds it running and opens the phone's port on its address.
		expect(yaml.indexOf("tailscale up")).toBeLessThan(yaml.indexOf("runuser"));
		const argv = JSON.parse(last.replace(/^ {2}- /, "")) as string[];
		expect(argv.slice(0, 4)).toEqual(["runuser", "-l", "ateam", "-c"]);
		expect(argv[4]).toBe(
			"set -o pipefail; curl -fsSL https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh | " +
				`ATEAM_PAIR_DEVICE=${HASH} ATEAM_PAIR_LABEL=iPhone bash -s -- --service --tailscale >~/ateam-install.log 2>&1`,
		);
	});

	test("installs the chosen agents first, as ateam, so the engine finds them when it starts", () => {
		const yaml = buildCloudInit({
			hostname: "my-box",
			tailscaleAuthKey: AUTHKEY,
			install: { agents: ["claude", "codex"] },
		});
		const lines = yaml.split("\n");
		const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
		expect(at("claude.ai/install.sh")).toBeGreaterThan(at("tailscale up"));
		expect(at("chatgpt.com/codex/install.sh")).toBeGreaterThan(at("claude.ai/install.sh"));
		expect(at("bash -s -- --service --tailscale")).toBeGreaterThan(at("chatgpt.com/codex"));
		const claude = JSON.parse((lines[at("claude.ai/install.sh")] ?? "").replace(/^ {2}- /, ""));
		expect(claude.slice(0, 4)).toEqual(["runuser", "-l", "ateam", "-c"]);
		expect(() =>
			buildCloudInit({
				hostname: "b",
				tailscaleAuthKey: AUTHKEY,
				install: { agents: ["rm -rf /" as "claude"] },
			}),
		).toThrow(/unknown agent/);
	});

	test("won't have a box install itself without an auth key, or pair something malformed", () => {
		expect(() => buildCloudInit({ hostname: "b", install: {} })).toThrow(/auth key/);
		for (const pairDevice of [
			{ tokenHash: "nothex", label: "iPhone" },
			{ tokenHash: HASH, label: "my phone; rm -rf ~" },
		]) {
			expect(() =>
				buildCloudInit({ hostname: "b", tailscaleAuthKey: AUTHKEY, install: { pairDevice } }),
			).toThrow(/device to pair/);
		}
	});

	test("rejects a value that isn't an SSH public key", () => {
		expect(() =>
			buildCloudInit({ hostname: "b", sshPublicKey: "rm -rf /", tailscaleAuthKey: AUTHKEY }),
		).toThrow(/SSH public key/);
	});
	test("quotes public-key comments so YAML punctuation stays part of the key", () => {
		const key = `${KEY}: phone #1`;
		const yaml = buildCloudInit({ hostname: "box", network: "ssh", sshPublicKey: key });
		const entry = yaml.split("\n").find((line) => line.startsWith("      - "));
		expect(JSON.parse(entry?.slice(8) ?? "null")).toBe(key);
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

	it("gives each size's monthly price where it's listed, tax included", () => {
		const [priced] = orderableServerTypes([
			{
				name: "cx23",
				cores: 2,
				memory: 4,
				locations: [{ name: "nbg1", available: true, deprecation: null }],
				prices: [
					{ location: "nbg1", price_monthly: { gross: "4.1531000000000000" } },
					{ location: "fsn1", price_monthly: {} },
				],
			},
		]);
		expect(priced?.monthly).toEqual({ nbg1: 4.1531 });
	});

	it("lists smallest first and says which are Arm or dedicated", () => {
		expect(offered.map((t) => t.slug)).toEqual(["cax11", "ccx13", "cpx31"]);
		expect(offered[0]?.label).toBe("CAX11 · 2 vCPU / 4 GB (Arm)");
		expect(offered[1]?.label).toBe("CCX13 · 2 vCPU / 8 GB (dedicated)");
		expect(offered[0]?.memory).toBe(4);
	});
});

describe("Hetzner, for a box with no SSH key", () => {
	/** A fake Hetzner API: answers by method and path, and records each call. */
	function fakeHetzner(answers: Record<string, unknown>) {
		const calls: { method: string; path: string; body: unknown }[] = [];
		const real = globalThis.fetch;
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			const path = url.replace("https://api.hetzner.cloud/v1", "");
			calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
			const key = `${method} ${path}`;
			if (!(key in answers)) return new Response("{}", { status: 404 });
			return new Response(JSON.stringify(answers[key]), { status: 200 });
		}) as typeof fetch;
		return { calls, restore: () => (globalThis.fetch = real) };
	}

	test("puts it behind the tailnet-only firewall, uploads no key, and says once it exists", async () => {
		const api = fakeHetzner({
			"GET /servers?name=b": { servers: [] },
			"GET /firewalls?name=ateam-tailnet-only": { firewalls: [] },
			"POST /firewalls": { firewall: { id: 7 } },
			"POST /servers": { server: { id: 42 }, action: { id: 1 } },
			"GET /servers/42/actions/1": { action: { status: "success" } },
			"GET /servers/42": { server: { public_net: { ipv4: { ip: "203.0.113.9" } } } },
		});
		const made: string[] = [];
		try {
			const server = await hetznerProvider.createServer({
				token: "t",
				name: "b",
				region: "nbg1",
				size: "cx23",
				cloudInit: "#cloud-config",
				onCreated: (id) => made.push(id),
			});
			expect(server).toEqual({ providerId: "42", publicIp: "203.0.113.9" });
		} finally {
			api.restore();
		}
		expect(made).toEqual(["42"]);
		expect(api.calls.some((c) => c.path.startsWith("/ssh_keys"))).toBe(false);
		const rules = (
			api.calls.find((c) => c.path === "/firewalls" && c.method === "POST")?.body as {
				rules: { protocol: string; port: string }[];
			}
		).rules;
		expect(rules.map((r) => `${r.protocol}/${r.port}`)).toEqual(["udp/41641"]);
		const create = api.calls.find((c) => c.path === "/servers" && c.method === "POST")?.body;
		expect(create).toMatchObject({ firewalls: [{ firewall: 7 }] });
		expect(create).not.toHaveProperty("ssh_keys");
	});

	test("an address that won't go is said, not swallowed: it bills on its own", async () => {
		const api = fakeHetzner({
			"GET /servers/42": { server: { public_net: { ipv4: { id: 5 } } } },
			"DELETE /servers/42": { action: { id: 9 } },
			"GET /actions/9": { action: { status: "success" } },
		});
		const real = globalThis.fetch;
		const fake = globalThis.fetch;
		// The address refuses (still assigned), rather than being gone (404).
		globalThis.fetch = (async (url: string, init?: RequestInit) =>
			String(url).endsWith("/primary_ips/5")
				? new Response(JSON.stringify({ error: { message: "primary ip is assigned" } }), {
						status: 422,
					})
				: fake(url, init)) as typeof fetch;
		try {
			const err = await hetznerProvider.deleteServer("t", "42").catch((e) => e);
			expect(err).toBeInstanceOf(LeftoverAddressesError);
			expect(String(err.message)).toContain("primary ip is assigned");
		} finally {
			globalThis.fetch = real;
			api.restore();
		}
	});

	test("deleting it deletes the addresses Hetzner made for it too", async () => {
		const api = fakeHetzner({
			"GET /servers/42": { server: { public_net: { ipv4: { id: 5 }, ipv6: { id: 6 } } } },
			"DELETE /servers/42": { action: { id: 9 } },
			"GET /actions/9": { action: { status: "success" } },
			"DELETE /primary_ips/5": {},
		});
		try {
			await hetznerProvider.deleteServer("t", "42");
		} finally {
			api.restore();
		}
		// The IPv6 one was gone already (404), which is fine.
		expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"GET /servers/42",
			"DELETE /servers/42",
			"GET /actions/9",
			"DELETE /primary_ips/5",
			"DELETE /primary_ips/6",
		]);
	});
});

describe("direct SSH cloud creation", () => {
	test("installs without Tailscale or a public RPC listener, with key-only SSH", () => {
		const yaml = buildCloudInit({
			hostname: "phone",
			network: "ssh",
			sshPublicKey: KEY,
			install: { agents: ["codex"] },
		});
		expect(yaml).toContain(KEY);
		expect(yaml).toContain("ssh_pwauth: false");
		expect(yaml).toContain("--service");
		expect(yaml).not.toContain("tailscale");
		expect(yaml).not.toContain("ATEAM_PAIR_DEVICE");
		expect(() => buildCloudInit({ hostname: "phone", network: "ssh", install: {} })).toThrow(
			/public key/,
		);
		expect(() =>
			buildCloudInit({ hostname: "phone", network: "ssh", sshPublicKey: `${KEY}\nruncmd: []` }),
		).toThrow(/public key/);
	});
	test("attaches an SSH-only firewall, persists the id before polling, refuses a modified firewall", async () => {
		const original = globalThis.fetch;
		try {
			for (const changed of [false, true]) {
				const calls: { path: string; body: Record<string, unknown> | null }[] = [];
				let saved = false;
				globalThis.fetch = (async (url: string, init?: RequestInit) => {
					const path = url.replace("https://api.hetzner.cloud/v1", "");
					const method = init?.method ?? "GET";
					calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
					const answers: Record<string, unknown> = {
						"GET /servers?name=phone": { servers: [] },
						"POST /ssh_keys": { ssh_key: { id: 3 } },
						"GET /firewalls?name=ateam-ssh-only": {
							firewalls: changed
								? [
										{
											id: 7,
											labels: { "managed-by": "ateam" },
											rules: [{ direction: "in", protocol: "tcp", port: "8787" }],
										},
									]
								: [],
						},
						"POST /firewalls": { firewall: { id: 7 } },
						"POST /servers": {
							server: { id: 42, public_net: { ipv4: { ip: "203.0.113.9" } } },
							action: { id: 1 },
						},
						"GET /servers/42/actions/1": { action: { status: "success" } },
						"GET /servers/42": { server: { public_net: { ipv4: { ip: "203.0.113.9" } } } },
					};
					if (path.includes("/actions/")) expect(saved).toBe(true);
					return new Response(JSON.stringify(answers[`${method} ${path}`] ?? {}));
				}) as typeof fetch;
				const result = hetznerProvider.createServer({
					token: "test",
					name: "phone",
					region: "nbg1",
					size: "cx23",
					sshPublicKey: KEY,
					directSSH: true,
					cloudInit: "#cloud-config",
					onCreated: async (id, ip) => {
						expect(id).toBe("42");
						expect(ip).toBe("203.0.113.9");
						await Promise.resolve();
						saved = true;
					},
				});
				if (changed) {
					await expect(result).rejects.toThrow(/different rules/);
					expect(calls.some((c) => c.path === "/servers")).toBe(false);
				} else {
					await result;
					expect(calls.find((c) => c.path === "/firewalls")?.body?.rules).toEqual([
						{
							description: "SSH access",
							direction: "in",
							protocol: "tcp",
							port: "22",
							source_ips: ["0.0.0.0/0", "::/0"],
						},
					]);
					expect(calls.find((c) => c.path === "/servers")?.body).toMatchObject({
						ssh_keys: [3],
						firewalls: [{ firewall: 7 }],
					});
				}
			}
		} finally {
			globalThis.fetch = original;
		}
	});
});
