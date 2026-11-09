// shortcut: boxd's SSH facts live here while its wake facts (incl. sshWakes) live in
// packages/protocol/src/providers.ts. Fold the `ssh` facts into ProviderDefinition when
// a second provider is reached over SSH, so each provider is described once.
//
// Where a new box can run, the first step of Create a box (src/CreateBoxScreen.tsx).
// Ateam Go creates a Hetzner server itself; at any other provider you make the
// machine there, and the phone then reaches it over SSH with what's below. Each
// provider is an entry of facts, not a flow of its own: its page in docs/providers
// has the long form, and adding one is adding an entry (and its mark, if it has one,
// in src/provider-logos.ts). Pure TS, so it's tested under bun.

/** What the Add a box form starts with for a machine made at a provider. */
export interface SSHSetup {
	/** The login a new machine there has. */
	user: string;
	/** What its host looks like, for the host field. */
	hostHint?: string;
	/** Where its SSH port is shown, when each machine has its own (not 22). */
	portHint?: string;
	/** What its password is called there, and where to get it. */
	password?: { label: string; help: string };
}

export interface ProviderSetup {
	/** A mark in src/provider-logos.ts, when there is one. */
	id: string;
	label: string;
	/** One line on the card: what this way in is. */
	body: string;
	/** Ateam Go creates the server itself (Hetzner's form). */
	creates?: boolean;
	/** What to do at the provider first, in order, each with where to do it. */
	steps?: { text: string; link?: { label: string; url: string } }[];
	/** Then connect over SSH with this. */
	ssh?: SSHSetup;
}

export const PROVIDER_SETUPS: readonly ProviderSetup[] = [
	{
		id: "hetzner",
		label: "Hetzner",
		body: "Ateam Go creates the server for you, billed to your Hetzner account.",
		creates: true,
	},
	{
		// The machine's phone sheet on app.boxd.sh, as it was on 2026-11-09: app icons
		// (Termius gets host, port and user by a link, the token by the clipboard), then
		// "Another SSH app": host <machine>.boxd.sh, its own port, user boxd, and a token
		// with Copy token, shown only while the sheet is open. docs.boxd.sh/guides/mobile.
		id: "boxd",
		label: "boxd",
		body: "Make a machine on boxd, then connect to it over SSH.",
		steps: [
			{ text: "Create a machine.", link: { label: "Open boxd", url: "https://app.boxd.sh" } },
			{
				text: "Open its phone page, then Another SSH app. Note its host and port, and tap Copy token: the token is its password.",
				link: { label: "Open the phone page", url: "https://app.boxd.sh/mobile" },
			},
		],
		ssh: {
			user: "boxd",
			hostHint: "machine.boxd.sh",
			portHint: "On its phone page",
			password: {
				label: "boxd token",
				help: "On the machine's phone page (app.boxd.sh/mobile): Another SSH app, Copy token. It works as the SSH password.",
			},
		},
	},
	{
		id: "other",
		label: "Another server",
		body: "Any Linux server you can reach over SSH: a VPS, a cloud machine, one of your own.",
		ssh: { user: "root" },
	},
];
