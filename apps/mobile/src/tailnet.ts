// Whether this phone is on a tailnet (modules/expo-tailnet), checked again each time
// the app comes back to the front: after the Tailscale app, it says what changed.
import { useEffect, useState } from "react";
import { AppState, Linking } from "react-native";
import { onTailnet } from "../modules/expo-tailnet/src";
import { TAILSCALE_APP_URL } from "./create-box";

/** On a tailnet now, or null where this build can't tell. */
export function useTailnet(): boolean | null {
	const [up, setUp] = useState<boolean | null>(() => onTailnet());
	useEffect(() => {
		const sub = AppState.addEventListener("change", (s) => {
			if (s === "active") setUp(onTailnet());
		});
		return () => sub.remove();
	}, []);
	return up;
}

/** The Tailscale app, or its App Store page where it isn't installed (which offers
 *  Open where it is: Tailscale documents no link into its app). */
export function openTailscale(): void {
	void Linking.openURL("tailscale://").catch(() => Linking.openURL(TAILSCALE_APP_URL));
}
