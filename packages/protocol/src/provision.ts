// Creating a box FROM SCRATCH at a cloud provider, so the user never has to open a
// provider console or hand-manage SSH keys. A BoxProvider turns a spec into a running
// Linux VM with a public IPv4, and buildCloudInit is what it runs on first boot: the
// `ateam` user and Tailscale. The desktop then installs the engine over SSH, streamed
// (it generates the SSH key, and keeps it and the token in the app). Ateam Go has no
// SSH, so a box it creates installs the engine itself at first boot (`install`).
// Pure TS on global fetch, so it runs in Electron's main process and in React Native.

/** A cloud host Ateam can create a box on. */
export interface BoxProvider {
	readonly id: string;
	readonly label: string;
	/** Create + start a server and return it once it has a public IPv4. Throws on API
	 *  error; `onProgress` narrates the stages for the UI. */
	createServer(input: CreateServerInput): Promise<CreatedServer>;
	/** The REAL per-account catalog for the picker — so we only ever offer regions and
	 *  sizes that actually exist and are in stock, never a hardcoded guess. */
	fetchOptions(token: string): Promise<ProviderOptions>;
	/** Delete a server this created (its `providerId`), which stops its bill. */
	deleteServer(token: string, providerId: string): Promise<void>;
}

/** What the picker shows once a token is entered — the provider's live catalog. */
export interface ProviderOptions {
	locations: { slug: string; label: string }[];
	/** `locations` = the location slugs this size can be ordered in (empty = unknown/any).
	 *  `monthly` = its monthly price in each location, tax included, where known. */
	serverTypes: {
		slug: string;
		label: string;
		locations: string[];
		memory: number;
		architecture?: string;
		monthly?: Record<string, number>;
	}[];
	/** The currency those prices are in ("EUR"), when the provider says. */
	currency?: string | null;
	/** What a server's public IPv4 address costs a month in each location, tax included,
	 *  billed beside the server. */
	ipv4Monthly?: Record<string, number>;
}

export interface CreateServerInput {
	/** The provider API token (the user's own — their account, their bill). */
	token: string;
	/** Server + ssh_config alias; also the Tailscale hostname. Sanitized by the caller. */
	name: string;
	/** Provider location slug (e.g. Hetzner `fsn1`). */
	region: string;
	/** Provider server-type slug (e.g. Hetzner `cx22`). */
	size: string;
	/** The OpenSSH public key to authorize on the box (`ssh-ed25519 AAAA…`). None for a
	 *  box Ateam Go creates, which is reached over the tailnet alone. */
	sshPublicKey?: string;
	/** cloud-init `user_data` run on first boot. */
	cloudInit: string;
	onProgress?: (stage: string) => void;
	/** The server exists (and bills) from here on, even if the rest fails. */
	onCreated?: (providerId: string) => void;
}

export interface CreatedServer {
	/** Provider's server id (opaque string), for later teardown. */
	providerId: string;
	publicIp: string;
}

/** A Tailscale auth key looks like `tskey-auth-…`; a box name is a DNS label. */
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const AUTHKEY_RE = /^tskey-auth-[A-Za-z0-9-]+$/;

/** What a device pairing itself through cloud-init may be called (no quoting needed). */
const LABEL_RE = /^[A-Za-z0-9._-]{1,40}$/;
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;

/** How a coding agent's CLI is put on a box, and the command that signs it in: each
 *  agent's own installer. The agents registry (packages/agents) reads these, and a
 *  box Ateam Go creates runs them at first boot. */
export const AGENT_INSTALLS = {
	claude: {
		label: "Claude Code",
		install: "curl -fsSL https://claude.ai/install.sh | bash",
		login: "claude login",
	},
	codex: {
		label: "Codex",
		install: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
		login: "codex login",
	},
} as const;

export type InstallableAgent = keyof typeof AGENT_INSTALLS;

/** The installer every box runs, the one the docs tell people to curl. */
export const INSTALL_SH_URL =
	"https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh";

/**
 * Build the cloud-init that makes a fresh box reachable exactly the way the rest of
 * Ateam expects: a non-root `ateam` user (the installer refuses to run as root), and
 * Tailscale up with SSH so the tailnet, not a password, is the auth boundary for both
 * the desktop (SSH) and the phone (the daemon's WebSocket). The desktop installs the
 * engine afterward over SSH, streamed; `install` has the box install it at first boot.
 */
export function buildCloudInit(opts: {
	hostname: string;
	/** The OpenSSH key `ateam` logs in with. Without one (a box Ateam Go creates), no
	 *  one logs in over the box's public SSH: password logins are off too, and the box
	 *  is reached over the tailnet alone. */
	sshPublicKey?: string;
	/** Joins the tailnet at boot. Without one, Tailscale is only installed, and the
	 *  engine's installer joins later (`--tailscale`), the user approving the box. */
	tailscaleAuthKey?: string;
	/** Install the engine at first boot, as a service on the tailnet: for a phone, which
	 *  has no SSH to stream the installer over. Needs the auth key, because nobody
	 *  would see the link to approve the box with. */
	install?: {
		/** The device creating the box, paired before the engine first starts: the sha256
		 *  (hex) of a token only that device holds, and what the box calls it. */
		pairDevice?: { tokenHash: string; label: string };
		/** Coding agents to install first, so the engine finds them when it starts. */
		agents?: InstallableAgent[];
		/** New boxes include a browser unless explicitly declined. */
		browser?: boolean;
	};
}): string {
	const { hostname, sshPublicKey, tailscaleAuthKey, install } = opts;
	if (!NAME_RE.test(hostname)) throw new Error(`invalid box name: ${hostname}`);
	if (tailscaleAuthKey !== undefined && !AUTHKEY_RE.test(tailscaleAuthKey)) {
		throw new Error("invalid Tailscale auth key");
	}
	if (sshPublicKey !== undefined && !/^ssh-(ed25519|rsa) /.test(sshPublicKey)) {
		throw new Error("invalid SSH public key");
	}
	if (install && !tailscaleAuthKey) {
		throw new Error("a box that installs itself needs a Tailscale auth key");
	}
	const pair = install?.pairDevice;
	const agents = install?.agents ?? [];
	if (agents.some((a) => !Object.hasOwn(AGENT_INSTALLS, a))) {
		throw new Error("unknown agent to install");
	}
	if (pair && (!TOKEN_HASH_RE.test(pair.tokenHash) || !LABEL_RE.test(pair.label))) {
		throw new Error("invalid device to pair");
	}
	// The values are validated above, so none can break out of the document or of
	// the shell lines below.
	const installer = install
		? [
				"set -o pipefail;",
				`curl -fsSL ${INSTALL_SH_URL} |`,
				...(pair ? [`ATEAM_PAIR_DEVICE=${pair.tokenHash} ATEAM_PAIR_LABEL=${pair.label}`] : []),
				`bash -s -- --service --tailscale${install.browser === false ? "" : " --browser"} >~/ateam-install.log 2>&1`,
			].join(" ")
		: null;
	return [
		"#cloud-config",
		"package_update: true",
		"packages: [curl]",
		"users:",
		"  - name: ateam",
		"    groups: [sudo]",
		'    sudo: "ALL=(ALL) NOPASSWD:ALL"',
		"    shell: /bin/bash",
		...(sshPublicKey ? ["    ssh_authorized_keys:", `      - ${sshPublicKey}`] : []),
		...(sshPublicKey ? [] : ["ssh_pwauth: false"]),
		"runcmd:",
		"  - curl -fsSL https://tailscale.com/install.sh | sh",
		// --operator=ateam lets the non-root user run `tailscale ip -4`, which the
		// engine installer reads to bake ATEAM_WS_ADDR (the phone's WebSocket listener).
		...(tailscaleAuthKey
			? [
					`  - tailscale up --ssh --authkey=${tailscaleAuthKey} --hostname=${hostname} --operator=ateam`,
				]
			: []),
		// As `ateam`, in a login shell, before the engine: it lists the agents it finds
		// on the login PATH. A failed one leaves the box without it, not without Ateam.
		...agents.map(
			(a) =>
				`  - ${JSON.stringify(["runuser", "-l", "ateam", "-c", `set -o pipefail; ${AGENT_INSTALLS[a].install} >>~/ateam-install.log 2>&1`])}`,
		),
		// As `ateam`, in a login shell; its passwordless sudo makes --service a system
		// unit. The log is where the box's own terminal can read what went wrong.
		...(installer ? [`  - ${JSON.stringify(["runuser", "-l", "ateam", "-c", installer])}`] : []),
	].join("\n");
}

const HETZNER_API = "https://api.hetzner.cloud/v1";
const CREATE_POLL_TRIES = 60;
const CREATE_POLL_MS = 3000;

/** A curated slice of Hetzner's catalog for the picker (the API accepts any valid slug). */
export const HETZNER_LOCATIONS = [
	{ slug: "fsn1", label: "Falkenstein 🇩🇪" },
	{ slug: "nbg1", label: "Nuremberg 🇩🇪" },
	{ slug: "hel1", label: "Helsinki 🇫🇮" },
	{ slug: "ash", label: "Ashburn, VA 🇺🇸" },
	{ slug: "hil", label: "Hillsboro, OR 🇺🇸" },
	{ slug: "sin", label: "Singapore 🇸🇬" },
];
export const HETZNER_SIZES = [
	{ slug: "cx22", label: "CX22 — 2 vCPU / 4 GB (x86)" },
	{ slug: "cx32", label: "CX32 — 4 vCPU / 8 GB (x86)" },
	{ slug: "cpx11", label: "CPX11 — 2 vCPU / 2 GB (AMD)" },
];

/** A refusal from Hetzner's API, with its HTTP status. */
export class HetznerError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "HetznerError";
	}
}

/** The server went, but some of the addresses Hetzner made for it didn't: they bill
 *  on their own until someone deletes them. */
export class LeftoverAddressesError extends Error {
	constructor(readonly reasons: string[]) {
		super(
			`The server is deleted, but ${reasons.length === 1 ? "one of its addresses isn't" : `${reasons.length} of its addresses aren't`} (${reasons.join("; ")}). Delete ${reasons.length === 1 ? "it" : "them"} in Hetzner's console, under Primary IPs, or ${reasons.length === 1 ? "it bills" : "they bill"} on its own.`,
		);
		this.name = "LeftoverAddressesError";
	}
}

/** One authenticated Hetzner API call, with their `{error:{message}}` shape unwrapped. */
async function hetznerCall(token: string, path: string, init?: RequestInit) {
	const res = await fetch(`${HETZNER_API}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...init?.headers,
		},
	});
	const text = await res.text();
	const body = text ? JSON.parse(text) : {};
	if (!res.ok) {
		throw new HetznerError(
			`Hetzner ${path}: ${body?.error?.message ?? `HTTP ${res.status}`}`,
			res.status,
		);
	}
	return body;
}

/** hetznerCall with the token bound. */
type HetznerCall = (path: string, init?: RequestInit) => ReturnType<typeof hetznerCall>;

/** A server type as Hetzner's API lists it (`GET /server_types`), the fields read here. */
interface HetznerServerType {
	name: string;
	cores: number;
	memory: number;
	cpu_type?: string;
	architecture?: string;
	/** Where it's supported, each with its own deprecation and stock (since 2025-09-24;
	 *  the type-wide `deprecated` flag was removed 2026-11-02). */
	locations?: { name: string; available?: boolean; deprecation?: unknown }[];
	/** What it costs in each location; `gross` includes the account's tax. */
	prices?: { location: string; price_monthly?: { gross?: string } }[];
}

/**
 * The sizes Create a box offers, and where each can be ordered: a location whose entry
 * has no deprecation and isn't out of stock. Hetzner deprecates a type per location
 * (the old shared AMD types left FSN, NBG, HEL and SIN on 2026-01-01), and ordering one
 * there fails with "unsupported location for server type". A type orderable nowhere is
 * left out; one with no `locations` at all is offered everywhere, since that says
 * nothing. Smallest first.
 */
export function orderableServerTypes(types: HetznerServerType[]): ProviderOptions["serverTypes"] {
	return types
		.map((t) => ({
			type: t,
			locations: (t.locations ?? [])
				.filter((l) => !l.deprecation && l.available !== false)
				.map((l) => l.name),
		}))
		.filter(({ type, locations }) => type.locations === undefined || locations.length > 0)
		.sort((a, b) => a.type.cores - b.type.cores || a.type.memory - b.type.memory)
		.map(({ type, locations }) => {
			const kind = [
				type.architecture === "arm" ? "Arm" : null,
				type.cpu_type === "dedicated" ? "dedicated" : null,
			].filter(Boolean);
			return {
				slug: type.name,
				label: `${type.name.toUpperCase()} · ${type.cores} vCPU / ${type.memory} GB${kind.length ? ` (${kind.join(", ")})` : ""}`,
				locations,
				memory: type.memory,
				architecture: type.architecture,
				monthly: Object.fromEntries(
					(type.prices ?? [])
						.map((p) => [p.location, Number(p.price_monthly?.gross)] as const)
						.filter(([, price]) => Number.isFinite(price)),
				),
			};
		});
}

/** A box Ateam Go creates is reached over the tailnet alone, so it lets nothing in from
 *  the internet but Tailscale's own direct connections. Shared by every such box. */
const TAILNET_ONLY = "ateam-tailnet-only";

/** The firewall for boxes reached over the tailnet alone, made the first time. */
async function tailnetOnlyFirewall(call: HetznerCall): Promise<number> {
	const found = await call(`/firewalls?name=${TAILNET_ONLY}`);
	const id = found.firewalls?.[0]?.id;
	if (typeof id === "number") return id;
	const made = await call("/firewalls", {
		method: "POST",
		body: JSON.stringify({
			name: TAILNET_ONLY,
			labels: { "managed-by": "ateam" },
			rules: [
				{
					description: "Tailscale direct connections",
					direction: "in",
					protocol: "udp",
					port: "41641",
					source_ips: ["0.0.0.0/0", "::/0"],
				},
			],
		}),
	});
	return made.firewall.id;
}

/** Each location's IPv4 price a month, from `GET /pricing`'s `primary_ips`. */
function ipv4Prices(primaryIps: unknown): Record<string, number> {
	if (!Array.isArray(primaryIps)) return {};
	const v4 = primaryIps.find((p) => p?.type === "ipv4");
	const prices: { location?: string; price_monthly?: { gross?: string } }[] = Array.isArray(
		v4?.prices,
	)
		? v4.prices
		: [];
	return Object.fromEntries(
		prices
			.map((p) => [p.location ?? "", Number(p.price_monthly?.gross)] as const)
			.filter(([location, price]) => location && Number.isFinite(price)),
	);
}

/** Wait for an action to finish (or fail): what follows it may need it done. */
async function settle(call: HetznerCall, actionId: unknown): Promise<void> {
	if (typeof actionId !== "number") return;
	for (let i = 0; i < CREATE_POLL_TRIES; i++) {
		const a = await call(`/actions/${actionId}`);
		if (a.action?.status !== "running") return;
		await new Promise((r) => setTimeout(r, CREATE_POLL_MS));
	}
}

export const hetznerProvider: BoxProvider = {
	id: "hetzner",
	label: "Hetzner Cloud",

	async fetchOptions(token) {
		const [locs, types, pricing] = await Promise.all([
			hetznerCall(token, "/locations"),
			hetznerCall(token, "/server_types?per_page=50"),
			// Only for the currency the prices are in: the picker works without it.
			hetznerCall(token, "/pricing").catch(() => null),
		]);
		const locations = (locs.locations ?? []).map((l: Record<string, string>) => ({
			slug: l.name,
			label: `${l.city ?? l.description ?? l.name}${l.country ? ` (${l.country})` : ""}`,
		}));
		const serverTypes = orderableServerTypes(types.server_types ?? []);
		const currency = pricing?.pricing?.currency;
		return {
			locations,
			serverTypes,
			currency: typeof currency === "string" ? currency : null,
			ipv4Monthly: ipv4Prices(pricing?.pricing?.primary_ips),
		};
	},

	// The server, then the addresses Hetzner made for it: they bill on their own, and
	// only go with the server when they were made to (`auto_delete`).
	async deleteServer(token, providerId) {
		const call = (path: string, init?: RequestInit) => hetznerCall(token, path, init);
		const id = encodeURIComponent(providerId);
		const srv = await call(`/servers/${id}`);
		const ips = [srv.server?.public_net?.ipv4?.id, srv.server?.public_net?.ipv6?.id].filter(
			(ip): ip is number => typeof ip === "number",
		);
		const deleted = await call(`/servers/${id}`, { method: "DELETE" });
		// Deleting the server detaches its addresses; one still attached can't be deleted.
		await settle(call, deleted.action?.id);
		const left: string[] = [];
		for (const ip of ips) {
			try {
				await call(`/primary_ips/${ip}`, { method: "DELETE" });
			} catch (err) {
				// Not found: it went with the server (auto_delete). Anything else still bills.
				if (!(err instanceof HetznerError && err.status === 404)) {
					left.push(err instanceof Error ? err.message : String(err));
				}
			}
		}
		if (left.length) throw new LeftoverAddressesError(left);
	},

	async createServer(input) {
		const call = (path: string, init?: RequestInit) => hetznerCall(input.token, path, init);

		// Never spin up (and bill) a second server with the same name, or touch an
		// existing one — refuse and let the user pick another name.
		input.onProgress?.("Checking the name is free");
		const dup = await call(`/servers?name=${encodeURIComponent(input.name)}`);
		if (dup.servers?.length) {
			throw new Error(
				`A box named "${input.name}" already exists on your Hetzner account. Pick another name.`,
			);
		}

		// A fresh key per box; if a prior attempt already uploaded this name, reuse it.
		// With none, Hetzner gives root a password and emails it: the firewall keeps
		// SSH from the internet out, and cloud-init turns password logins off.
		let keyId: number | null = null;
		if (input.sshPublicKey) {
			input.onProgress?.("Uploading SSH key");
			const keyName = `ateam-${input.name}`;
			try {
				const k = await call("/ssh_keys", {
					method: "POST",
					body: JSON.stringify({ name: keyName, public_key: input.sshPublicKey }),
				});
				keyId = k.ssh_key.id;
			} catch {
				const found = await call(`/ssh_keys?name=${encodeURIComponent(keyName)}`);
				const existing = found.ssh_keys?.[0];
				if (!existing) throw new Error(`could not upload or find SSH key "${keyName}"`);
				keyId = existing.id;
			}
		}

		input.onProgress?.("Creating server");
		// public_net.enable_ipv4 is REQUIRED now — Hetzner stopped auto-assigning a
		// public IPv4, and without one there's no address to SSH into or curl from.
		const created = await call("/servers", {
			method: "POST",
			body: JSON.stringify({
				name: input.name,
				server_type: input.size,
				image: "ubuntu-24.04",
				location: input.region,
				public_net: { enable_ipv4: true, enable_ipv6: true },
				...(keyId !== null
					? { ssh_keys: [keyId] }
					: { firewalls: [{ firewall: await tailnetOnlyFirewall(call) }] }),
				user_data: input.cloudInit,
				// Tag it as ours so we can list/identify Ateam boxes and, later, safely make
				// Create idempotent for boxes WE made (never a user's own same-named server).
				labels: { "managed-by": "ateam" },
				start_after_create: true,
			}),
		});
		const serverId: number = created.server.id;
		const actionId: number = created.action.id;
		input.onCreated?.(String(serverId));

		input.onProgress?.("Provisioning");
		let ok = false;
		for (let i = 0; i < CREATE_POLL_TRIES; i++) {
			const a = await call(`/servers/${serverId}/actions/${actionId}`);
			const status = a.action?.status;
			if (status === "success") {
				ok = true;
				break;
			}
			if (status === "error") {
				throw new Error(`Hetzner create failed: ${a.action?.error?.message ?? "unknown"}`);
			}
			await new Promise((r) => setTimeout(r, CREATE_POLL_MS));
		}
		if (!ok) throw new Error("Hetzner create did not finish in time");

		const srv = await call(`/servers/${serverId}`);
		const ip = srv.server?.public_net?.ipv4?.ip;
		if (!ip) throw new Error("server came up without a public IPv4");
		return { providerId: String(serverId), publicIp: ip };
	},
};
