// A box being created on Hetzner from this phone (src/CreateBoxScreen.tsx). Held by
// the app, not the page, so leaving the page doesn't stop it. The box goes on the
// Boxes list as soon as Hetzner has made it, so even a restart of the app doesn't
// lose it: the phone then reaches it like any saved box, once its install is done.
import { hetznerProvider, type InstallableAgent, LeftoverAddressesError } from "@ateam/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { boxKey } from "./boxes";
import { BOX_PORT, newDeviceToken, phoneCloudInit } from "./create-box";
import type { Links } from "./links";
import { type SavedConnection, saveBoxToken } from "./storage";

/** How often the phone tries the box while its install runs. */
const TRY_EVERY_MS = 5_000;

export interface CreateSpec {
	/** The Hetzner API token (the user's own: their account, their bill). */
	token: string;
	tailscaleAuthKey: string;
	name: string;
	size: string;
	location: string;
	/** Coding agents the box installs at first boot. */
	agents: InstallableAgent[];
}

export interface Creation {
	name: string;
	/** Where the phone reaches it: its tailnet name, or an address typed in. */
	box: SavedConnection;
	/** creating: Hetzner is making the server. installing: it boots and installs
	 *  Ateam, while the phone keeps trying it. done: it answered. failed: see error. */
	step: "creating" | "installing" | "done" | "failed";
	error: string | null;
	/** Hetzner's id for it, once it exists: what Delete the server deletes. */
	serverId: string | null;
	/** When Hetzner had made it, for how long the install has run. */
	createdAt: number | null;
	/** Deleting it on Hetzner. */
	deleting: boolean;
}

/** expo-crypto, loaded when first used: a build from before it has no native side. */
function crypto(): typeof import("expo-crypto") {
	return require("expo-crypto") as typeof import("expo-crypto");
}

export function useBoxCreation(deps: {
	link: Links;
	/** How this phone names itself to the box. */
	label: string;
	/** Put the box on the Boxes list (in place of `replaces`). */
	saveBox: (box: SavedConnection, replaces?: string | null) => void;
	/** Take it off the list, and off the board. */
	removeBox: (key: string) => void;
	/** It answered: what the app does for a new box. */
	onConnected: (key: string) => void;
}) {
	const [creation, setCreation] = useState<Creation | null>(null);
	// The token the box was made with: Delete needs it, and it's never in render state.
	const hetznerToken = useRef<string | null>(null);
	// This phone's token for the box, for a move to another address.
	const deviceToken = useRef<string | null>(null);
	const { link, label, saveBox, removeBox, onConnected } = deps;
	const latest = useRef({ saveBox, removeBox, onConnected });
	latest.current = { saveBox, removeBox, onConnected };
	const creationRef = useRef(creation);
	creationRef.current = creation;

	const create = useCallback(
		async (spec: CreateSpec) => {
			// Always on: a Hetzner server bills while it's up and nothing sleeps it, so the
			// phone never waits to wake it, nor asks which provider would.
			const box: SavedConnection = { host: spec.name, port: BOX_PORT, sleeps: false };
			const base: Creation = {
				name: spec.name,
				box,
				step: "creating",
				error: null,
				serverId: null,
				createdAt: null,
				deleting: false,
			};
			setCreation(base);
			hetznerToken.current = spec.token;
			try {
				// The async one: the sync one falls back to Math.random under a debugger.
				const c = crypto();
				const bytes = await c.getRandomBytesAsync(32);
				const token = newDeviceToken(() => bytes);
				const tokenHash = await c.digestStringAsync(c.CryptoDigestAlgorithm.SHA256, token, {
					encoding: c.CryptoEncoding.HEX,
				});
				// Kept before the box exists: it's the phone's way in from its first boot.
				await saveBoxToken(boxKey(box), token);
				deviceToken.current = token;
				await hetznerProvider.createServer({
					token: spec.token,
					name: spec.name,
					region: spec.location,
					size: spec.size,
					cloudInit: phoneCloudInit({
						name: spec.name,
						tailscaleAuthKey: spec.tailscaleAuthKey,
						tokenHash,
						label,
						agents: spec.agents,
					}),
					onCreated: (serverId) => {
						latest.current.saveBox(box);
						setCreation((cur) => (cur ? { ...cur, serverId, createdAt: Date.now() } : cur));
					},
				});
				setCreation((cur) => (cur ? { ...cur, step: "installing" } : cur));
			} catch (e) {
				const error = e instanceof Error ? e.message : String(e);
				setCreation((cur) => {
					// No server came of it: nothing to keep a token for.
					if (cur && !cur.serverId) void saveBoxToken(boxKey(box), null).catch(() => {});
					return cur ? { ...cur, step: "failed", error } : cur;
				});
			}
		},
		[label],
	);

	// While it installs, try it every few seconds: it answers once its engine is up.
	const installing = creation?.step === "installing" ? creation.box : null;
	useEffect(() => {
		if (!installing) return;
		let live = true;
		const key = boxKey(installing);
		const attempt = async () => {
			if (!live) return;
			if (link.conn(key) || (await link.connect(installing, { save: true }))) {
				if (!live) return;
				live = false;
				setCreation((cur) => (cur ? { ...cur, step: "done", error: null } : cur));
				latest.current.onConnected(key);
			}
		};
		void attempt();
		const t = setInterval(() => void attempt(), TRY_EVERY_MS);
		return () => {
			live = false;
			clearInterval(t);
		};
	}, [installing, link]);

	/** Reach it at an address typed in (from the Tailscale app) instead of its name. */
	const reachAt = useCallback(async (host: string) => {
		const cur = creationRef.current;
		const token = deviceToken.current;
		if (!cur || !token || !host.trim()) return;
		const next: SavedConnection = { host: host.trim(), port: BOX_PORT, sleeps: false };
		const old = boxKey(cur.box);
		await saveBoxToken(boxKey(next), token);
		latest.current.saveBox(next, old);
		// As the form does for a box moved to another address: the old one stops being
		// tried, and its token goes.
		if (old !== boxKey(next)) {
			latest.current.removeBox(old);
			void saveBoxToken(old, null).catch(() => {});
		}
		setCreation({ ...cur, box: next, step: "installing", error: null });
	}, []);

	/** Delete the server on Hetzner, so it stops billing, and forget the box. */
	const deleteServer = useCallback(async () => {
		const cur = creationRef.current;
		const token = hetznerToken.current;
		if (!cur) return;
		if (cur.serverId && token) {
			setCreation({ ...cur, deleting: true });
			try {
				await hetznerProvider.deleteServer(token, cur.serverId);
			} catch (e) {
				if (e instanceof LeftoverAddressesError) {
					// The server is gone, so the box goes too; what's left is said once.
					Alert.alert("Deleted, but not all of it", e.message);
				} else {
					setCreation({
						...cur,
						deleting: false,
						error: `Couldn't delete it on Hetzner: ${e instanceof Error ? e.message : String(e)}. Delete it in Hetzner's console.`,
					});
					return;
				}
			}
		}
		latest.current.removeBox(boxKey(cur.box));
		void saveBoxToken(boxKey(cur.box), null).catch(() => {});
		hetznerToken.current = null;
		deviceToken.current = null;
		setCreation(null);
	}, []);

	/** Done with it (connected, or a failure read): the page starts over next time. */
	const dismiss = useCallback(() => {
		hetznerToken.current = null;
		setCreation(null);
	}, []);

	return { creation, create, reachAt, deleteServer, dismiss };
}
