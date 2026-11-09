// A box being created on Hetzner from this phone (src/CreateBoxScreen.tsx). Held by
// the app, not the page, so leaving the page doesn't stop it. The box goes on the
// Boxes list as soon as Hetzner has made it, so even a restart of the app doesn't
// lose it: the phone then reaches it like any saved box, once its install is done.
import { hetznerProvider, type InstallableAgent, LeftoverAddressesError } from "@ateam/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { sshNative } from "../modules/expo-ssh/src";
import { boxKey } from "./boxes";
import { BOX_PORT, newDeviceToken, phoneCloudInit } from "./create-box";
import type { Links } from "./links";
import { verifySSH } from "./ssh";
import { type SavedConnection, saveBoxToken } from "./storage";

/** How often the phone tries the box while its install runs. */
const TRY_EVERY_MS = 5_000;

export interface CreateSpec {
	network?: "tailscale" | "ssh";
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
	verifying: boolean;
}

/** expo-crypto, loaded when first used: a build from before it has no native side. */
function crypto(): typeof import("expo-crypto") {
	return require("expo-crypto") as typeof import("expo-crypto");
}

export function useBoxCreation(deps: {
	link: Links;
	savedBox: (host: string) => SavedConnection | undefined;
	/** How this phone names itself to the box. */
	label: string;
	/** Put the box on the Boxes list (in place of `replaces`). */
	saveBox: (box: SavedConnection, replaces?: string | null) => Promise<void>;
	/** Take it off the list, and off the board. */
	removeBox: (key: string) => void;
	/** It answered: what the app does for a new box. */
	onConnected: (key: string) => void;
}) {
	const [creation, setCreation] = useState<Creation | null>(null);
	// The token the box was made with: Delete needs it, and it's never in render state.
	const creating = useRef(false);
	const verifying = useRef(false);
	const revision = useRef(0);
	const hetznerToken = useRef<string | null>(null);
	// This phone's token for the box, for a move to another address.
	const deviceToken = useRef<string | null>(null);
	const { link, label, saveBox, removeBox, onConnected } = deps;
	const latest = useRef({ saveBox, removeBox, onConnected, savedBox: deps.savedBox });
	latest.current = { saveBox, removeBox, onConnected, savedBox: deps.savedBox };
	const creationRef = useRef(creation);
	creationRef.current = creation;

	const create = useCallback(
		async (spec: CreateSpec) => {
			if (creating.current) return;
			creating.current = true;
			revision.current++;
			// Always on: a Hetzner server bills while it's up and nothing sleeps it, so the
			// phone never waits to wake it, nor asks which provider would.
			let box: SavedConnection = {
				host: spec.name,
				port: spec.network === "ssh" ? "22" : BOX_PORT,
				sleeps: false,
			};
			const base: Creation = {
				name: spec.name,
				box,
				step: "creating",
				error: null,
				serverId: null,
				createdAt: null,
				deleting: false,
				verifying: false,
			};
			setCreation(base);
			hetznerToken.current = spec.token;
			try {
				// The async one: the sync one falls back to Math.random under a debugger.
				const c = crypto();
				let sshPublicKey: string | undefined;
				if (spec.network === "ssh") {
					const previous = latest.current.savedBox(spec.name);
					if (previous?.createdServer)
						throw new Error("This server is already saved. Edit its address to reconnect.");
					const identity = previous?.ssh?.auth === "key" ? previous.ssh.identity : c.randomUUID();
					sshPublicKey = await sshNative().createKey(identity);
					box = { ...box, ssh: { user: "ateam", identity, auth: "key" } };
					setCreation((cur) => (cur ? { ...cur, box } : cur));
					// Persist the device key reference BEFORE a billable request. If its
					// response is lost, the user can recover the IP from Hetzner.
					await latest.current.saveBox(box);
				}
				const bytes = await c.getRandomBytesAsync(32);
				const token = newDeviceToken(() => bytes);
				const tokenHash = await c.digestStringAsync(c.CryptoDigestAlgorithm.SHA256, token, {
					encoding: c.CryptoEncoding.HEX,
				});
				// Kept before the box exists: it's the phone's way in from its first boot.
				if (!box.ssh) await saveBoxToken(boxKey(box), token);
				deviceToken.current = token;
				const made = await hetznerProvider.createServer({
					sshPublicKey,
					directSSH: spec.network === "ssh",
					token: spec.token,
					name: spec.name,
					region: spec.location,
					size: spec.size,
					cloudInit: phoneCloudInit({
						sshPublicKey,
						name: spec.name,
						tailscaleAuthKey: spec.tailscaleAuthKey,
						tokenHash,
						label,
						agents: spec.agents,
					}),
					onCreated: async (serverId, publicIp) => {
						const old = boxKey(box);
						box = {
							...box,
							createdServer: { provider: "hetzner", id: serverId },
							...(box.ssh && publicIp ? { host: publicIp } : {}),
						};
						setCreation((cur) => (cur ? { ...cur, box, serverId, createdAt: Date.now() } : cur));
						await latest.current.saveBox(box, old);
						if (old !== boxKey(box)) latest.current.removeBox(old);
					},
				});
				if (box.ssh && box.host !== made.publicIp) {
					const old = boxKey(box);
					box = { ...box, host: made.publicIp };
					await latest.current.saveBox(box, old);
					latest.current.removeBox(old);
				}
				setCreation((cur) => (cur ? { ...cur, box, step: "installing" } : cur));
			} catch (e) {
				const error = e instanceof Error ? e.message : String(e);
				setCreation((cur) => {
					// No server came of it: nothing to keep a token for.
					if (cur && !cur.serverId) void saveBoxToken(boxKey(box), null).catch(() => {});
					return cur ? { ...cur, step: "failed", error } : cur;
				});
			} finally {
				creating.current = false;
			}
		},
		[label],
	);

	// While it installs, try it every few seconds: it answers once its engine is up.
	const installing = creation?.step === "installing" ? creation.box : null;
	useEffect(() => {
		if (!installing || (installing.ssh && !installing.ssh.hostKey)) return;
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

	const verify = useCallback(async () => {
		const cur = creationRef.current;
		if (!cur?.box.ssh || cur.deleting || verifying.current) return;
		const version = revision.current;
		verifying.current = true;
		setCreation((v) => (v ? { ...v, verifying: true } : v));
		try {
			const box = await verifySSH(cur.box);
			if (version !== revision.current) return;
			await latest.current.saveBox(box);
			setCreation((v) => (v ? { ...v, box, error: null } : v));
		} catch (e) {
			if (version === revision.current) setCreation((v) => (v ? { ...v, error: String(e) } : v));
		} finally {
			verifying.current = false;
			if (version === revision.current) setCreation((v) => (v ? { ...v, verifying: false } : v));
		}
	}, []);

	/** Reach it at an address typed in (from the Tailscale app) instead of its name. */
	const reachAt = useCallback(async (host: string) => {
		const cur = creationRef.current;
		const token = deviceToken.current;
		if (!cur || !token || !host.trim()) return;
		const next: SavedConnection = { host: host.trim(), port: BOX_PORT, sleeps: false };
		const old = boxKey(cur.box);
		await saveBoxToken(boxKey(next), token);
		await latest.current.saveBox(next, old);
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
		revision.current++;
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
		revision.current++;
		hetznerToken.current = null;
		setCreation(null);
	}, []);

	return { creation, create, reachAt, deleteServer, dismiss, verify };
}
