import { requireOptionalNativeModule } from "expo";
import { randomUUID } from "expo-crypto";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { sshAvailable, sshNative } from "../modules/expo-ssh/src";
import type { SavedConnection } from "./storage";
import { C } from "./theme";

export interface SSHForm {
	enabled: boolean;
	user: string;
	auth: "password" | "key";
	identity: string;
	password: string;
	publicKey: string;
	hostKey?: string;
	pinnedHost?: string;
	pinnedPort?: string;
}
/** A new server's own login: root, which setup turns into an `ateam` user (src/ssh.ts). */
export const emptySSHForm = (): SSHForm => ({
	enabled: false,
	user: "root",
	auth: "password",
	identity: "",
	password: "",
	publicKey: "",
});
export function savedSSHForm(box: SavedConnection | null): SSHForm {
	return {
		...emptySSHForm(),
		...(box?.ssh ?? {}),
		enabled: Boolean(box?.ssh),
		pinnedHost: box?.host.trim().toLowerCase(),
		pinnedPort: box?.port || "22",
	};
}
export async function saveSSHForm(form: SSHForm): Promise<NonNullable<SavedConnection["ssh"]>> {
	if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*[$]?$/.test(form.user.trim()))
		throw new Error("Enter a valid SSH username.");
	const identity = form.identity || randomUUID();
	if (form.auth === "password") {
		if (!form.password && !form.identity) throw new Error("Enter the SSH password.");
		if (form.password) await sshNative().savePassword(identity, form.password);
	} else if (!form.identity)
		throw new Error("Generate a key and authorize its public key on the server first.");
	return { user: form.user.trim(), identity, auth: form.auth, hostKey: form.hostKey };
}

/** iOS's own Paste control (UIPasteControl, iOS 16+): one tap pastes what a provider
 *  copied (boxd copies the token), with no "Allow Paste" prompt. Importing
 *  expo-clipboard loads its native side at once (ExpoClipboard.js), which a build made
 *  before it lacks, so it's required only once that side is known to be there. */
function pasteControl(): typeof import("expo-clipboard").ClipboardPasteButton | null {
	if (!requireOptionalNativeModule("ExpoClipboard")) return null;
	const clipboard = require("expo-clipboard") as typeof import("expo-clipboard");
	return clipboard.isPasteButtonAvailable ? clipboard.ClipboardPasteButton : null;
}
const PasteButton = pasteControl();

export function SSHFields({
	value,
	onChange,
	disabled,
	password,
}: {
	value: SSHForm;
	onChange(value: SSHForm): void;
	disabled: boolean;
	/** What the password is called at the box's provider, and where it comes from. */
	password?: { label: string; help: string };
}) {
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const generate = async () => {
		setBusy(true);
		setError(null);
		try {
			const identity = value.identity || randomUUID();
			const publicKey = await sshNative().createKey(identity);
			onChange({ ...value, identity, publicKey });
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<View style={styles.root}>
			<View style={styles.row}>
				{([false, true] as const).map((enabled) => (
					<Pressable
						key={String(enabled)}
						disabled={disabled || (enabled && !sshAvailable)}
						accessibilityRole="radio"
						accessibilityState={{ checked: value.enabled === enabled }}
						style={[styles.choice, value.enabled === enabled && styles.chosen]}
						onPress={() => onChange({ ...value, enabled })}
					>
						<Text style={styles.text}>{enabled ? "SSH" : "Tailscale"}</Text>
					</Pressable>
				))}
			</View>
			{!sshAvailable && (
				<Text style={styles.help}>SSH requires an iOS build with native SSH support.</Text>
			)}
			{value.enabled && (
				<>
					<Text style={styles.help}>
						Connect directly to a reachable server. Keys and passwords stay in this phone's
						Keychain.
					</Text>
					<Text style={styles.text}>SSH user</Text>
					<TextInput
						accessibilityLabel="SSH user"
						style={styles.input}
						value={value.user}
						editable={!disabled}
						autoCapitalize="none"
						autoCorrect={false}
						onChangeText={(user) => onChange({ ...value, user })}
					/>
					{value.user.trim() === "root" ? (
						<Text style={styles.help}>
							A new server's password is the one your provider emailed or showed when you created
							it. Ateam then sets up its own user, which logs in with a key on this phone.
						</Text>
					) : null}
					<View style={styles.row}>
						{(["password", "key"] as const).map((auth) => (
							<Pressable
								key={auth}
								accessibilityRole="radio"
								accessibilityState={{ checked: value.auth === auth }}
								disabled={disabled}
								style={[styles.choice, value.auth === auth && styles.chosen]}
								onPress={() => {
									if (auth !== value.auth)
										onChange({ ...value, auth, identity: "", password: "", publicKey: "" });
								}}
							>
								<Text style={styles.text}>{auth === "key" ? "Device key" : "Password"}</Text>
							</Pressable>
						))}
					</View>
					{value.auth === "password" ? (
						<>
							<View style={styles.passwordRow}>
								<TextInput
									style={[styles.input, styles.passwordInput]}
									value={value.password}
									editable={!disabled}
									accessibilityLabel={password?.label ?? "SSH password"}
									secureTextEntry
									autoCapitalize="none"
									autoCorrect={false}
									placeholder={
										value.identity
											? "Saved · enter a new password to replace"
											: (password?.label ?? "SSH password")
									}
									placeholderTextColor={C.muted}
									onChangeText={(typed) => onChange({ ...value, password: typed })}
								/>
								{PasteButton && !disabled ? (
									<PasteButton
										style={styles.paste}
										acceptedContentTypes={["plain-text"]}
										displayMode="labelOnly"
										cornerStyle="medium"
										// White on the app's dark ground: the highlight colour, and
										// contrast iOS asks of this control.
										backgroundColor={C.ink}
										foregroundColor={C.bg}
										onPress={(data) => {
											// A copied token can carry the line break it was copied with.
											if (data.type === "text")
												onChange({ ...value, password: data.text.replace(/\r?\n$/, "") });
										}}
									/>
								) : null}
							</View>
							{password ? <Text style={styles.help}>{password.help}</Text> : null}
						</>
					) : (
						<>
							<Pressable
								accessibilityRole="button"
								disabled={disabled || busy}
								onPress={() => void generate()}
								style={styles.choice}
							>
								<Text style={styles.text}>
									{busy
										? "Reading key…"
										: value.identity
											? "Show public key"
											: "Generate device key"}
								</Text>
							</Pressable>
							{value.publicKey ? (
								<Text selectable style={styles.help}>
									{value.publicKey}
								</Text>
							) : null}
							<Text style={styles.help}>
								Add this public key to the provider or the user's ~/.ssh/authorized_keys. The
								private key stays on this device; keep another recovery method.
							</Text>
						</>
					)}
					<Text style={styles.help}>
						SSH access is controlled by the server's credentials. Removing this box or revoking a
						paired phone does not revoke its SSH key.
					</Text>
				</>
			)}
			{error && <Text style={styles.help}>{error}</Text>}
		</View>
	);
}
const styles = StyleSheet.create({
	root: { gap: 12, marginBottom: 18 },
	row: { flexDirection: "row", gap: 10 },
	choice: { borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 12 },
	chosen: { borderColor: C.ink },
	text: { color: C.ink, fontSize: 14 },
	help: { color: C.muted, fontSize: 12, lineHeight: 18 },
	input: { color: C.ink, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 12 },
	passwordRow: { flexDirection: "row", alignItems: "center", gap: 10 },
	passwordInput: { flex: 1 },
	// iOS draws nothing for this control without a size of its own.
	paste: { width: 80, height: 44 },
});
