// Box providers Ateam can do more with than SSH into, as DATA: what a client asks
// the user for, and how it labels it. What happens with those values is code, one
// adapter per provider (the phone's are in apps/mobile/src/wake.ts), because no two
// providers wake a box the same way: boxd exchanges a key for a token and speaks
// gRPC-web, Hetzner and Fly take one REST call, AWS signs every request. The same
// split DevPod and Omnara landed on. See docs/providers/README.md.

/** One value a provider needs, shown as one field. */
export interface ProviderInput {
	/** What the adapter reads it as. It also names a Keychain item, so letters,
	 *  digits, ".", "-" and "_" only (the same goes for the provider's id). */
	key: string;
	label: string;
	placeholder: string;
	/** "account": entered once and shared by every box at this provider (an API key).
	 *  "box": one per box (its machine name). */
	scope: "account" | "box";
	/** Masked while typed, kept in the Keychain, never shown again once saved. */
	secret?: boolean;
}

export interface ProviderDefinition {
	id: string;
	label: string;
	/** Present when a client can wake this provider's sleeping boxes through its API. */
	wake?: {
		inputs: ProviderInput[];
		/** One line beside the provider in a picker. */
		hint: string;
		/** Shown under the fields once picked: what happens with them, and how far a key reaches. */
		note: string;
	};
}

export const PROVIDERS: readonly ProviderDefinition[] = [
	{
		id: "boxd",
		label: "boxd",
		wake: {
			inputs: [
				{ key: "machine", label: "Machine", placeholder: "mybox", scope: "box" },
				{ key: "apiKey", label: "API key", placeholder: "bxd_…", scope: "account", secret: true },
			],
			hint: "Wakes a hibernated machine before connecting",
			note:
				"Before connecting, the phone asks boxd to wake this machine if it's asleep. The key " +
				"stays in this phone's Keychain and goes only to boxd. A boxd key works on every " +
				"machine in its org, so give the phone one for an org that holds only your Ateam boxes.",
		},
	},
	{
		id: "sprites",
		label: "Sprites",
		wake: {
			inputs: [
				{ key: "machine", label: "Sprite", placeholder: "mybox", scope: "box" },
				// The whole token Sprites shows: org-slug/org-id/token-id/token-value.
				{ key: "token", label: "API token", placeholder: "my-org/…", scope: "account", secret: true },
			],
			hint: "Wakes a paused Sprite before connecting",
			note:
				"Before connecting, the phone asks Sprites to wake this Sprite and keep it up for two " +
				"minutes while it connects. The token stays in this phone's Keychain and goes only to " +
				"Sprites. A Sprites token works on every Sprite in its organization, so give the phone " +
				"one for an organization that holds only your Ateam boxes.",
		},
	},
];

export function providerById(id: string | null | undefined): ProviderDefinition | undefined {
	return id ? PROVIDERS.find((p) => p.id === id) : undefined;
}
