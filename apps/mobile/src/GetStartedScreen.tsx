// The first screen, for a phone with no box yet: two ways to one. Pair with a Mac
// that has boxes (one scan of Settings → Boxes → Pair your iPhone), or create a box
// on Hetzner from here (src/CreateBoxScreen.tsx). A box set up some other way, with
// Ateam's installer, is added by its address; and the demo needs nothing.
import Feather from "@expo/vector-icons/Feather";
import type { ReactNode } from "react";
import { Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native";

import { shareMacApp } from "./mac-app";
import { ScanQrIcon } from "./ScanQrIcon";
import { openTailscale, useTailnet } from "./tailnet";
import { C, CONTENT_MAX } from "./theme";

function Door({
	icon,
	title,
	body,
	action,
	onPress,
	link,
}: {
	icon: ReactNode;
	title: string;
	body: string;
	action: string;
	onPress: () => void;
	/** A page to read about it, beside the action. */
	link?: { label: string; onPress: () => void };
}) {
	return (
		<Pressable
			style={({ pressed }) => [styles.door, pressed && styles.pressed]}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={`${title}. ${body}`}
		>
			<View style={styles.doorHead}>
				{icon}
				<Text style={styles.doorTitle}>{title}</Text>
			</View>
			<Text style={styles.doorBody}>{body}</Text>
			<View style={styles.doorFoot}>
				{link ? (
					<Pressable onPress={link.onPress} hitSlop={8} accessibilityRole="link">
						<Text style={styles.link}>{link.label}</Text>
					</Pressable>
				) : null}
				<View style={styles.doorAction}>
					<Text style={styles.doorActionText}>{action}</Text>
					<Feather name="chevron-right" size={15} color={C.ink} />
				</View>
			</View>
		</Pressable>
	);
}

/** The two other ways in, a row each: the same card, at half the height. */
function SmallDoor({
	icon,
	title,
	body,
	onPress,
}: {
	icon: ReactNode;
	title: string;
	body: string;
	onPress: () => void;
}) {
	return (
		<Pressable
			style={({ pressed }) => [styles.small, pressed && styles.pressed]}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={`${title}. ${body}`}
		>
			{icon}
			<View style={styles.smallText}>
				<Text style={styles.smallTitle}>{title}</Text>
				<Text style={styles.smallBody} numberOfLines={1}>
					{body}
				</Text>
			</View>
			<Feather name="chevron-right" size={16} color={C.muted} />
		</Pressable>
	);
}

/** Whether this phone is on Tailscale, which both ways to a box need, and the way to
 *  turn it on where it isn't. A build that can't tell just says it's needed. */
function TailscaleState() {
	const up = useTailnet();
	if (up) {
		return (
			<View style={styles.tsOn}>
				<Feather name="check" size={14} color={C.green} />
				<Text style={styles.note}>This phone is on Tailscale.</Text>
			</View>
		);
	}
	if (up === false) {
		return (
			<View style={styles.tsOff}>
				<View style={styles.tsText}>
					<Text style={styles.tsTitle}>Tailscale is off on this phone</Text>
					<Text style={styles.tsBody}>
						It reaches your boxes over Tailscale, signed in to the account they're on.
					</Text>
				</View>
				<Pressable style={styles.tsBtn} onPress={openTailscale} accessibilityRole="button">
					<Text style={styles.tsBtnText}>Turn on</Text>
				</Pressable>
			</View>
		);
	}
	return (
		<View style={styles.tailscale}>
			<Text style={styles.note}>
				This phone needs the Tailscale app, signed in to the account your boxes are on.
			</Text>
			<Pressable onPress={openTailscale} hitSlop={6} accessibilityRole="link">
				<Text style={styles.link}>Get Tailscale</Text>
			</Pressable>
		</View>
	);
}

export function GetStartedScreen({
	leading,
	onScan,
	onCreate,
	creating,
	onHaveBox,
	onDemo,
	error,
	scanner,
}: {
	leading: ReactNode;
	onScan: () => void;
	onCreate: () => void;
	/** A box being created here, by name: the second door goes back to it. */
	creating: string | null;
	onHaveBox: () => void;
	onDemo: () => void;
	error: string | null;
	scanner: ReactNode;
}) {
	return (
		<View style={styles.root}>
			<StatusBar barStyle="light-content" backgroundColor={C.bg} />
			<View style={styles.navBar}>
				{leading}
				<Text style={styles.navTitle}>Get started</Text>
			</View>
			<ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
				<View style={styles.column}>
					<Text style={styles.intro}>
						Ateam Go runs your agents on a box: a Linux machine of your own, which this phone
						reaches over Tailscale.
					</Text>
					<TailscaleState />
					<Door
						icon={<ScanQrIcon size={18} color={C.ink} />}
						title="Pair with Ateam for Mac"
						body="Scan the code Ateam for Mac shows, and every box it has joins this phone."
						action="Scan the code"
						onPress={onScan}
						link={{ label: "Get Ateam for Mac", onPress: shareMacApp }}
					/>
					<Door
						icon={<Feather name="server" size={17} color={C.ink} />}
						title="Create a box here"
						body={
							creating
								? `${creating} is being set up on Hetzner.`
								: "A server of your own on Hetzner Cloud, billed to your Hetzner account and set up from this phone."
						}
						action={creating ? "See how it's going" : "Create a box"}
						onPress={onCreate}
					/>
					{error ? (
						<View style={styles.errorBox}>
							<Text style={styles.errorText}>{error}</Text>
						</View>
					) : null}

					<SmallDoor
						icon={<Feather name="link-2" size={17} color={C.ink} />}
						title="I already have a box"
						body="Add it by its address on your tailnet"
						onPress={onHaveBox}
					/>
					<SmallDoor
						icon={<Feather name="play-circle" size={17} color={C.ink} />}
						title="Try the demo"
						body="Look around first, no box needed"
						onPress={onDemo}
					/>
				</View>
			</ScrollView>
			{scanner}
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg, paddingTop: 60 },
	navBar: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingHorizontal: 18,
		paddingBottom: 14,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
	},
	navTitle: { color: C.ink, fontSize: 17, fontWeight: "700", letterSpacing: -0.2 },
	content: { padding: 16, paddingTop: 20, paddingBottom: 40 },
	column: { width: "100%", maxWidth: CONTENT_MAX, alignSelf: "center", gap: 12 },
	intro: { color: C.muted, fontSize: 14, lineHeight: 20 },
	door: {
		gap: 8,
		padding: 16,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: C.line,
		backgroundColor: C.surface,
	},
	pressed: { opacity: 0.7 },
	doorHead: { flexDirection: "row", alignItems: "center", gap: 10 },
	doorTitle: { color: C.ink, fontSize: 16, fontWeight: "700" },
	doorBody: { color: C.muted, fontSize: 13, lineHeight: 19 },
	doorFoot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
	doorAction: { flexDirection: "row", alignItems: "center", gap: 2, marginLeft: "auto" },
	doorActionText: { color: C.ink, fontSize: 14, fontWeight: "600" },
	tailscale: { gap: 6, paddingHorizontal: 4 },
	tsOn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 },
	tsOff: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		padding: 14,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: C.amber,
		backgroundColor: C.surface,
	},
	tsText: { flex: 1, gap: 3 },
	tsTitle: { color: C.ink, fontSize: 15, fontWeight: "600" },
	tsBody: { color: C.muted, fontSize: 12, lineHeight: 17 },
	tsBtn: {
		height: 34,
		paddingHorizontal: 14,
		borderRadius: 17,
		backgroundColor: C.ink,
		alignItems: "center",
		justifyContent: "center",
	},
	tsBtnText: { color: C.bg, fontSize: 14, fontWeight: "700" },
	note: { color: C.faint, fontSize: 12, lineHeight: 17 },
	link: { color: C.ink, fontSize: 13, fontWeight: "600", textDecorationLine: "underline" },
	errorBox: {
		padding: 12,
		borderRadius: 10,
		borderWidth: 1,
		borderColor: C.red,
		backgroundColor: "rgba(248,113,113,0.08)",
	},
	errorText: { color: C.red, fontSize: 13, lineHeight: 18 },
	small: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingHorizontal: 16,
		paddingVertical: 12,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: C.line,
		backgroundColor: C.surface,
	},
	smallText: { flex: 1, gap: 2 },
	smallTitle: { color: C.ink, fontSize: 15, fontWeight: "600" },
	smallBody: { color: C.muted, fontSize: 12 },
});
