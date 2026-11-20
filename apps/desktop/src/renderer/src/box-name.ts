import { type Alias, aliasLabel, type ConnectionDTO, wakeMachineName } from "@ateam/protocol";
import { createContext, useContext } from "react";

/**
 * What the app calls a machine, wherever it names one: Local for this Mac; a box
 * by its machine name at the provider that wakes it (a Sprite's hostname, boxd's
 * name), as on the phone, else by its alias (the ssh_config Host, or a ws box's
 * host:port). A ws box's alias is often a bare tailnet IP, which says nothing.
 */
export function boxName(
	alias: Alias,
	connections: readonly Pick<ConnectionDTO, "alias" | "wake">[],
): string {
	if (alias === null) return aliasLabel(null);
	return wakeMachineName(connections.find((c) => c.alias === alias)?.wake) ?? alias;
}

/** `boxName` over the app's current connections. Outside the app (a component
 *  rendered on its own) it falls back to the alias. */
export const BoxNameContext = createContext<(alias: Alias) => string>(aliasLabel);

export const useBoxName = () => useContext(BoxNameContext);
