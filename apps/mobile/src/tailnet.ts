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

/** Tailscale's App Store page, which offers Open where the app is installed and Get
 *  where it isn't. Tailscale documents no link into its app, and iOS hands a scheme no
 *  app claims to Safari ("the address is invalid") rather than failing. */
export function openTailscale(): void {
	void Linking.openURL(TAILSCALE_APP_URL);
}
