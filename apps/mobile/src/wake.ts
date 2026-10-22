// Waking a sleeping box before the phone connects, for any provider that declares
// it (packages/protocol/src/providers.ts). The definition says what to ask the user
// for; the adapter here says what to do with it. A provider defined with `wake` but
// with no adapter in this file is not offered: data alone can't wake anything.
//
// Pure TS, no React Native imports, so it runs under bun test.
import { PROVIDERS, type ProviderDefinition, type ProviderInput } from "@ateam/protocol";
import { createBoxdClient, ensureAwake } from "./boxd";

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
};

/** The providers the phone can actually wake: defined with `wake` AND backed by an adapter. */
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

/** An adapter for `def` signed in with `account`, or null when the phone can't wake it. */
export function wakeAdapter(def: ProviderDefinition, account: InputValues): WakeAdapter | null {
	const make = ADAPTERS[def.id];
	return make && def.wake ? make(account) : null;
}
