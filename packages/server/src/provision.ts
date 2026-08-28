// Creating a box FROM SCRATCH at a cloud provider, so the user never has to open a
// provider console or hand-manage SSH keys. A BoxProvider turns a spec into a running
// Linux VM with a public IPv4; the caller (desktop main) then generates the SSH key,
// bakes a cloud-init that stands up the `ateam` user + Tailscale, and reuses the SSH
// installer to bring up the engine. This module is pure (fetch + strings) — the
// Electron-specific bits (key material, secret storage, ~/.ssh/config) live in the app.

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
}

/** What the picker shows once a token is entered — the provider's live catalog. */
export interface ProviderOptions {
	locations: { slug: string; label: string }[];
	/** `locations` = the location slugs this size is available in (empty = unknown/any). */
	serverTypes: { slug: string; label: string; locations: string[] }[];
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
	/** The OpenSSH public key to authorize on the box (`ssh-ed25519 AAAA…`). */
	sshPublicKey: string;
	/** cloud-init `user_data` run on first boot. */
	cloudInit: string;
	onProgress?: (stage: string) => void;
}

export interface CreatedServer {
	/** Provider's server id (opaque string), for later teardown. */
	providerId: string;
	publicIp: string;
}

/** A Tailscale auth key looks like `tskey-auth-…`; a box name is a DNS label. */
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const AUTHKEY_RE = /^tskey-auth-[A-Za-z0-9-]+$/;

/**
 * Build the cloud-init that makes a fresh box reachable exactly the way the rest of
 * Ateam expects: a non-root `ateam` user carrying our SSH key (the installer refuses
 * to run as root), and Tailscale up with SSH so the tailnet — not a password — is the
 * auth boundary for both the desktop (SSH) and the phone (the daemon's WebSocket).
 * The engine itself is installed afterward over SSH (streamed), not here.
 */
export function buildCloudInit(opts: {
	hostname: string;
	sshPublicKey: string;
	tailscaleAuthKey: string;
}): string {
	const { hostname, sshPublicKey, tailscaleAuthKey } = opts;
	if (!NAME_RE.test(hostname)) throw new Error(`invalid box name: ${hostname}`);
	if (!AUTHKEY_RE.test(tailscaleAuthKey)) throw new Error("invalid Tailscale auth key");
	if (!/^ssh-(ed25519|rsa) /.test(sshPublicKey)) throw new Error("invalid SSH public key");
	// A YAML literal — the key and authkey are validated above so neither can break out
	// of the document or the shell line below.
	return [
		"#cloud-config",
		"package_update: true",
		"packages: [curl]",
		"users:",
		"  - name: ateam",
		"    groups: [sudo]",
		'    sudo: "ALL=(ALL) NOPASSWD:ALL"',
		"    shell: /bin/bash",
		"    ssh_authorized_keys:",
		`      - ${sshPublicKey}`,
		"runcmd:",
		"  - curl -fsSL https://tailscale.com/install.sh | sh",
		// --operator=ateam lets the non-root user run `tailscale ip -4`, which the
		// engine installer reads to bake ATEAM_WS_ADDR (the phone's WebSocket listener).
		`  - tailscale up --ssh --authkey=${tailscaleAuthKey} --hostname=${hostname} --operator=ateam`,
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
	if (!res.ok) throw new Error(`Hetzner ${path}: ${body?.error?.message ?? `HTTP ${res.status}`}`);
	return body;
}

// Availability per location moved onto server_types.locations — the datacenters
// `server_types.available` field is deprecated (removed 2026-10-01). Read defensively:
// the entry may be a slug string or an object keyed by `location`/`name`.
function locationSlugsOf(st: { locations?: unknown[] }): string[] {
	return (st.locations ?? [])
		.map((l) =>
			typeof l === "string"
				? l
				: ((l as { location?: string; name?: string })?.location ?? (l as { name?: string })?.name),
		)
		.filter((s): s is string => typeof s === "string");
}

export const hetznerProvider: BoxProvider = {
	id: "hetzner",
	label: "Hetzner Cloud",

	async fetchOptions(token) {
		const [locs, types] = await Promise.all([
			hetznerCall(token, "/locations"),
			hetznerCall(token, "/server_types?per_page=50"),
		]);
		const locations = (locs.locations ?? []).map((l: Record<string, string>) => ({
			slug: l.name,
			label: `${l.city ?? l.description ?? l.name}${l.country ? ` (${l.country})` : ""}`,
		}));
		const serverTypes = (types.server_types ?? [])
			// Skip globally-deprecated types (Hetzner marks them with a `deprecation` object).
			.filter((t: Record<string, unknown>) => !t.deprecation && !t.deprecated)
			.map((t: Record<string, unknown>) => ({
				slug: t.name as string,
				label: `${String(t.name).toUpperCase()} — ${t.cores} vCPU / ${t.memory} GB${t.cpu_type === "dedicated" ? " (dedicated)" : ""}`,
				locations: locationSlugsOf(t as { locations?: unknown[] }),
				cores: Number(t.cores) || 0,
			}))
			.sort((a: { cores: number }, b: { cores: number }) => a.cores - b.cores)
			.map(
				({
					cores: _cores,
					...rest
				}: {
					cores: number;
					slug: string;
					label: string;
					locations: string[];
				}) => rest,
			);
		return { locations, serverTypes };
	},

	async createServer(input) {
		const call = (path: string, init?: RequestInit) => hetznerCall(input.token, path, init);

		// Never spin up (and bill) a second server with the same name, or touch an
		// existing one — refuse and let the user pick another name.
		input.onProgress?.("Checking the name is free");
		const dup = await call(`/servers?name=${encodeURIComponent(input.name)}`);
		if (dup.servers?.length) {
			throw new Error(
				`A box named "${input.name}" already exists on your Hetzner account. Pick another name, or connect to an existing box with "Set up a box over SSH".`,
			);
		}

		input.onProgress?.("Uploading SSH key");
		// A fresh key per box; if a prior attempt already uploaded this name, reuse it.
		const keyName = `ateam-${input.name}`;
		let keyId: number;
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
				ssh_keys: [keyId],
				user_data: input.cloudInit,
				// Tag it as ours so we can list/identify Ateam boxes and, later, safely make
				// Create idempotent for boxes WE made (never a user's own same-named server).
				labels: { "managed-by": "ateam" },
				start_after_create: true,
			}),
		});
		const serverId: number = created.server.id;
		const actionId: number = created.action.id;

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
