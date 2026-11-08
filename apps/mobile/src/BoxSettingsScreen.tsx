import type { PairingState } from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { boxSubtitle, boxTitle, type SavedBox } from "./boxes";
import { ProviderIcon } from "./ProviderIcon";
import { C, CONTENT_MAX } from "./theme";

/** The box card stays compact; configuration and security live here. */
export function BoxSettingsScreen({
	box,
	connected,
	security,
	onClose,
	onGithub,
	onAiKeys,
	onDotfiles,
	onLock,
}: {
	box: SavedBox;
	connected: boolean;
	security: PairingState["state"] | "unknown";
	onClose: () => void;
	onGithub: () => void;
	onAiKeys: () => void;
	onDotfiles: () => void;
	onLock: () => Promise<void>;
}) {
	return (
		<View style={styles.root}>
			<View style={styles.header}>
				<Pressable
					style={styles.back}
					onPress={onClose}
					accessibilityRole="button"
					accessibilityLabel="Back to Boxes"
				>
					<Feather name="chevron-left" size={20} color={C.ink} />
					<Text style={styles.backText}>Boxes</Text>
				</Pressable>
				<Text style={styles.title}>Box settings</Text>
			</View>
			<ScrollView contentContainerStyle={styles.content}>
				<View style={styles.column}>
					<View style={styles.identity}>
						<ProviderIcon providerId={box.provider?.id} />
						<View style={styles.identityText}>
							<Text style={styles.name}>{boxTitle(box)}</Text>
							<Text style={styles.note}>
								{boxSubtitle(box)} · {connected ? "Connected" : "Not connected"}
							</Text>
						</View>
					</View>
					<Text style={styles.sectionTitle}>Configuration</Text>
					<View style={styles.group}>
						{(
							[
								{
									label: "GitHub",
									detail: "Repository access and sign-in",
									icon: "github",
									onPress: onGithub,
								},
								{
									label: "AI keys",
									detail: "API keys used by this box",
									icon: "key",
									onPress: onAiKeys,
								},
								{
									label: "Dotfiles",
									detail: "Shell, tools and agent configuration",
									icon: "file-text",
									onPress: onDotfiles,
								},
							] as const
						).map((item, i) => (
							<Pressable
								key={item.label}
								style={({ pressed }) => [
									styles.row,
									i > 0 && styles.divider,
									pressed && styles.pressed,
									!connected && styles.disabled,
								]}
								onPress={item.onPress}
								disabled={!connected}
								accessibilityRole="button"
								accessibilityLabel={item.label}
								accessibilityState={{ disabled: !connected }}
							>
								<Feather name={item.icon} size={20} color={C.muted} />
								<View style={styles.rowText}>
									<Text style={styles.rowTitle}>{item.label}</Text>
									<Text style={styles.note}>{item.detail}</Text>
								</View>
								<Feather name="chevron-right" size={18} color={C.muted} />
							</Pressable>
						))}
					</View>
					{!connected ? (
						<Text style={styles.note}>Connect to this box from Boxes to change its settings.</Text>
					) : null}
					<Text style={styles.sectionTitle}>Security</Text>
					{connected && security === "open" ? (
						<LockSection onLock={onLock} />
					) : (
						<View style={styles.security}>
							<Feather name="shield" size={20} color={C.muted} />
							<Text style={styles.securityText}>
								{!connected
									? "Connect to check this box’s pairing status."
									: security === "paired"
										? "Only paired devices can control this box."
										: security === "trusted"
											? "This connection is trusted by the box."
											: "Pairing status is unavailable. Connect or update the box to manage device access."}
							</Text>
						</View>
					)}
				</View>
			</ScrollView>
		</View>
	);
}

function LockSection({ onLock }: { onLock: () => Promise<void> }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const run = async () => {
		setBusy(true);
		setError(null);
		try {
			await onLock();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	const lock = () =>
		Alert.alert(
			"Make this box private?",
			"Only devices paired with it can use it from then on, starting with this phone. Your Mac, if it reaches the box over Tailscale, needs a code too: get one with `ateam pair` in this box's terminal (the terminal button on its card).",
			[
				{ text: "Cancel", style: "cancel" },
				{ text: "Make private", onPress: () => void run() },
			],
		);
	return (
		<View style={styles.lockSection}>
			<Text style={styles.rowTitle}>Device access</Text>
			<Text style={styles.warning}>
				Open to your Tailscale network: any device on it can use this box. Make it private to the
				devices you pair.
			</Text>
			<Pressable
				style={[styles.lockButton, busy && styles.disabled]}
				disabled={busy}
				onPress={lock}
				accessibilityRole="button"
			>
				<Text style={styles.lockText}>{busy ? "Making private…" : "Make private"}</Text>
			</Pressable>
			{error ? <Text style={styles.error}>{error}</Text> : null}
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg, paddingTop: 60 },
	header: {
		flexDirection: "row",
		alignItems: "center",
		gap: 20,
		paddingHorizontal: 16,
		paddingBottom: 12,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
	},
	back: { flexDirection: "row", alignItems: "center", minHeight: 44 },
	backText: { color: C.ink, fontSize: 15 },
	title: { color: C.ink, fontSize: 17, fontWeight: "700" },
	content: { padding: 18, paddingBottom: 40 },
	column: { width: "100%", maxWidth: CONTENT_MAX, alignSelf: "center", gap: 12 },
	identity: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
	identityText: { flex: 1, gap: 4 },
	name: { color: C.ink, fontSize: 20, fontWeight: "600" },
	note: { color: C.muted, fontSize: 13, lineHeight: 18 },
	sectionTitle: { color: C.muted, fontSize: 13, fontWeight: "600", marginTop: 18 },
	group: {
		backgroundColor: C.surface,
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 12,
		overflow: "hidden",
	},
	row: { flexDirection: "row", alignItems: "center", gap: 14, padding: 16, minHeight: 76 },
	rowText: { flex: 1, gap: 4 },
	rowTitle: { color: C.ink, fontSize: 15, fontWeight: "600" },
	divider: { borderTopWidth: 1, borderTopColor: C.line },
	pressed: { backgroundColor: C.sunken },
	disabled: { opacity: 0.5 },
	security: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		padding: 16,
		backgroundColor: C.surface,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: C.line,
	},
	securityText: { flex: 1, color: C.muted, fontSize: 13, lineHeight: 19 },
	lockSection: {
		gap: 12,
		padding: 16,
		backgroundColor: C.surface,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: C.line,
	},
	warning: { color: C.amber, fontSize: 13, lineHeight: 19 },
	lockButton: {
		alignSelf: "flex-start",
		minHeight: 44,
		justifyContent: "center",
		paddingHorizontal: 16,
		borderRadius: 8,
		backgroundColor: C.ink,
	},
	lockText: { color: C.bg, fontSize: 14, fontWeight: "600" },
	error: { color: C.red, fontSize: 13 },
});
