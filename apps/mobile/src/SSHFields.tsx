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

export function SSHFields({
	value,
	onChange,
	disabled,
}: {
	value: SSHForm;
	onChange(value: SSHForm): void;
	disabled: boolean;
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
						<TextInput
							style={styles.input}
							value={value.password}
							editable={!disabled}
							accessibilityLabel="SSH password"
							secureTextEntry
							autoCapitalize="none"
							autoCorrect={false}
							placeholder={
								value.identity ? "Saved · enter a new password to replace" : "SSH password"
							}
							placeholderTextColor={C.muted}
							onChangeText={(password) => onChange({ ...value, password })}
						/>
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
});
