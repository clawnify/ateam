// Waking a sleeping box before a client connects to it over the tailnet (Ateam Go,
// and the desktop for a box added by its Tailscale address), for any provider that
// declares it (providers.ts). The definition says what to ask the user
// for; the adapter here says what to do with it. A provider defined with `wake` but
// with no adapter in this file is not offered: data alone can't wake anything.
//
// Pure TS on global fetch: it runs in React Native, in Electron's main process
// (Node 20) and under bun test alike.
import { PROVIDERS, type ProviderDefinition, type ProviderInput } from "./providers";
import { createBoxdClient, ensureAwake } from "./wake-boxd";
import { createSpritesClient } from "./wake-sprites";

/** Input values by `ProviderInput.key`. */
export type InputValues = Record<string, string>;

export interface WakeAdapter {
	/** Make sure the box is up before connecting; resolves with the state it was found in. */
	ensureAwake(box: InputValues): Promise<string>;
	/** One cheap signed-in call, so a key that doesn't work is reported when it's
	 *  saved rather than as a failed wake at the next connect. */
	check(): Promise<void>;
}

const ADAPTERS: Partial<Record<string, (account: InputValues) => WakeAdapter>> = {
	boxd: (account) => {
		const client = createBoxdClient((account.apiKey ?? "").trim());
		return {
			ensureAwake: (box) => ensureAwake(client, (box.machine ?? "").trim()),
			check: () => client.check(),
		};
	},
	sprites: (account) => {
		const client = createSpritesClient((account.token ?? "").trim());
		return {
			// Sprites' reported status lags, so the state it was found in is not known.
			ensureAwake: async (box) => {
				await client.wake((box.machine ?? "").trim());
				return "unknown";
			},
			check: () => client.check(),
		};
	},
};

/** The providers a client can actually wake: defined with `wake` AND backed by an adapter. */
export const WAKE_PROVIDERS: readonly ProviderDefinition[] = PROVIDERS.filter(
	(p) => p.wake && ADAPTERS[p.id],
);

export function inputsAt(def: ProviderDefinition, scope: ProviderInput["scope"]): ProviderInput[] {
	return def.wake?.inputs.filter((i) => i.scope === scope) ?? [];
}

/** Every input the definition declares at `scope` has a value. */
export function filled(
	def: ProviderDefinition,
	scope: ProviderInput["scope"],
	values: InputValues,
): boolean {
	return inputsAt(def, scope).every((i) => (values[i.key] ?? "").trim() !== "");
}

/** What a box said in hello (SystemInfo.provider) wakes it, when a client can wake
 *  through that provider and the box named itself there; else null. Only the
 *  provider's box inputs are kept: a box never tells a client an account value. */
export function reportedWake(
	reported: { id: string; box: Record<string, string> } | null | undefined,
): { id: string; box: Record<string, string> } | null {
	const def = WAKE_PROVIDERS.find((p) => p.id === reported?.id);
	if (!def || !reported || typeof reported.box !== "object" || reported.box === null) return null;
	const box: InputValues = {};
	for (const input of inputsAt(def, "box")) {
		const value = reported.box[input.key];
		if (typeof value !== "string" || value.trim() === "") return null;
		box[input.key] = value.trim();
	}
	return { id: def.id, box };
}

/** The provider a box says it runs on in hello, when it is one Ateam knows: a provider
 *  a client can wake as reportedWake has it (its box inputs, all present), and any
 *  other known one by its id alone, so a client can name it. Null for one it doesn't
 *  know, which an older client ignores the same way. */
export function reportedProvider(
	reported: { id: string; box: Record<string, string> } | null | undefined,
): { id: string; box: Record<string, string> } | null {
	const def = PROVIDERS.find((p) => p.id === reported?.id);
	if (!def) return null;
	return def.wake ? reportedWake(reported) : { id: def.id, box: {} };
}

/** What people call a box a provider wakes: its machine name there (the first of the
 *  provider's box inputs), or null when it has none and the address has to do. */
export function wakeMachineName(
	wake: { id: string; box: Record<string, string> } | null | undefined,
): string | null {
	const def = PROVIDERS.find((p) => p.id === wake?.id);
	const nameInput = def ? inputsAt(def, "box")[0] : undefined;
	const name = nameInput ? (wake?.box[nameInput.key] ?? "").trim() : "";
	return name || null;
}

/** An adapter for `def` signed in with `account`, or null when no client can wake it. */
export function wakeAdapter(def: ProviderDefinition, account: InputValues): WakeAdapter | null {
	const make = ADAPTERS[def.id];
	return make && def.wake ? make(account) : null;
}
