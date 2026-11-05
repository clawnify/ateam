// Create a box on Hetzner from the phone: what the page offers and what it sends.
// The Hetzner client and the box's cloud-init are @ateam/protocol's (provision.ts),
// the same the desktop's Create a box uses; what differs is that the phone has no
// SSH, so the box installs Ateam itself at first boot and pairs this phone before its
// engine first starts (`install` in buildCloudInit). Pure, so it's tested on its own.
import { buildCloudInit, type InstallableAgent, type ProviderOptions } from "@ateam/protocol";

/** The provider definition's id for Hetzner, for its account key in the Keychain. */
export const HETZNER_ACCOUNT = "hetzner";

/** Where each credential is made (the desktop's Create a box links the same pages). */
export const HETZNER_TOKENS_URL = "https://console.hetzner.com/projects";
export const TAILSCALE_KEYS_URL = "https://console.tailscale.com/admin/settings/keys";
export const TAILSCALE_APP_URL = "https://apps.apple.com/app/id1470499037";
/** Where Ateam for Mac is downloaded: the repo's page, whose first link is the .dmg
 *  (a phone can't open a .dmg, but can pass the page on to the Mac). */
export const MAC_APP_URL = "https://github.com/clawnify/ateam";

/** Where the phone dials a box it created: its name on the tailnet (MagicDNS), and the
 *  port the installer opens there. */
export const BOX_PORT = "8787";

/** A name nobody has used yet: a box made again under an old name would get `-1` on
 *  the tailnet, and the old name would find the old machine. */
export function defaultBoxName(random: (n: number) => Uint8Array): string {
	const letters = "abcdefghjkmnpqrstuvwxyz23456789";
	return `ateam-${[...random(4)].map((b) => letters[b % letters.length]).join("")}`;
}

/** A box name as typed, as a DNS label (also its Tailscale name), or null. */
export function boxNameOf(raw: string): string | null {
	const s = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63)
		.replace(/-+$/g, "");
	return s || null;
}

type Size = ProviderOptions["serverTypes"][number];

/** The sizes a location can order, smallest first (as the catalog lists them). */
export function sizesIn(options: ProviderOptions, location: string): Size[] {
	return options.serverTypes.filter(
		(t) => t.locations.length === 0 || t.locations.includes(location),
	);
}

/** Where to start: the first location that sells a size with 4 GB, and the smallest of
 *  those (agents need about a gigabyte each; the desktop starts from the same). Else
 *  the smallest anywhere. */
export function defaultsOf(options: ProviderOptions): { location: string; size: string } | null {
	for (const enough of [true, false]) {
		for (const l of options.locations) {
			const size = sizesIn(options, l.slug).find((t) => !enough || t.memory >= 4);
			if (size) return { location: l.slug, size: size.slug };
		}
	}
	return null;
}

/** "4.15 EUR a month, plus 0.61 for its IPv4 address": what Hetzner bills for it. */
export function priceLine(options: ProviderOptions, size: string, location: string): string | null {
	const server = options.serverTypes.find((t) => t.slug === size)?.monthly?.[location];
	if (server === undefined) return null;
	const currency = options.currency ?? "";
	const ipv4 = options.ipv4Monthly?.[location];
	const money = (n: number) => `${n.toFixed(2)}${currency ? ` ${currency}` : ""}`;
	return ipv4 === undefined
		? `${money(server)} a month, plus Hetzner's fee for its IPv4 address`
		: `${money(server + ipv4)} a month: ${money(server)} for the server and ${money(ipv4)} for its IPv4 address`;
}

/** The token this phone pairs with: 32 random bytes as hex, which the box never sees. */
export function newDeviceToken(random: (n: number) => Uint8Array): string {
	return [...random(32)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The box's cloud-init: on the tailnet, Ateam installed, this phone paired. */
export function phoneCloudInit(opts: {
	name: string;
	tailscaleAuthKey: string;
	tokenHash: string;
	label: string;
	agents: InstallableAgent[];
}): string {
	return buildCloudInit({
		hostname: opts.name,
		tailscaleAuthKey: opts.tailscaleAuthKey,
		install: {
			pairDevice: { tokenHash: opts.tokenHash, label: opts.label },
			agents: opts.agents,
		},
	});
}

/** The Agent choices on Create a box: what each puts on the box. */
export const AGENT_CHOICES: { slug: string; label: string; agents: InstallableAgent[] }[] = [
	{ slug: "claude", label: "Claude Code", agents: ["claude"] },
	{ slug: "codex", label: "Codex", agents: ["codex"] },
	{ slug: "both", label: "Claude Code and Codex", agents: ["claude", "codex"] },
	{ slug: "none", label: "None, I'll install one", agents: [] },
];
