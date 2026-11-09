// The first screen, for a phone with no box yet: two ways to one. Pair with a Mac
// that has boxes (one scan of Settings → Boxes → Pair your iPhone), or create a box
// on Hetzner from here (src/CreateBoxScreen.tsx). A server of your own is added over
// SSH or by its tailnet address; and the demo needs nothing. Only the Mac's boxes need
// Tailscale on this phone, so that's the one door that says whether it's on.
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
	note,
}: {
	icon: ReactNode;
	title: string;
	body: string;
	action: string;
	onPress: () => void;
	/** A page to read about it, beside the action. */
	link?: { label: string; onPress: () => void };
	/** What this way in needs on the phone, under its body. */
	note?: ReactNode;
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
			{note}
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

/** Whether this phone is on Tailscale, which the Mac's boxes are reached over, and
 *  the way to turn it on where it isn't. A build that can't tell says it's needed. */
function TailscaleNote() {
	const up = useTailnet();
	if (up) {
		return (
			<View style={styles.tsRow}>
				<Feather name="check" size={14} color={C.green} />
				<Text style={styles.note}>This phone is on Tailscale.</Text>
			</View>
		);
	}
	return (
		<View style={styles.tsRow}>
			<View style={[styles.tsDot, up === false && { backgroundColor: C.amber }]} />
			<Text style={styles.note}>
				{up === false ? "Tailscale is off on this phone." : "Needs Tailscale on this phone."}
			</Text>
			<Pressable onPress={openTailscale} hitSlop={8} accessibilityRole="link">
				<Text style={styles.link}>{up === false ? "Turn on" : "Get Tailscale"}</Text>
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
						reaches over Tailscale or SSH.
					</Text>
					<Door
						icon={<ScanQrIcon size={18} color={C.ink} />}
						title="Pair with Ateam for Mac"
						body="Scan the code Ateam for Mac shows, and every box it has joins this phone."
						action="Scan the code"
						onPress={onScan}
						link={{ label: "Get Ateam for Mac", onPress: shareMacApp }}
						note={<TailscaleNote />}
					/>
					<Door
						icon={<Feather name="server" size={17} color={C.ink} />}
						title="Create a box here"
						body={
							creating
								? `${creating} is being set up on Hetzner.`
								: "Pick where it runs: Hetzner, set up from this phone, boxd, Sprites, exe.dev or another server."
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
						body="Connect using SSH or a tailnet address"
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
	tsRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
	tsDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.faint },
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
