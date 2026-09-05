// The shortcut bar under a terminal: TUI control bytes the soft keyboard can't
// send. Shared by the full terminal screen and Mission Control's tiles.
// PgUp/PgDn drive the TUI's OWN scroll (Claude Code scrolls its conversation on
// PageUp/PageDown in every mode) — the reliable way to scroll a full-screen agent,
// vs the emulator scrollback (empty on an alt-screen).
import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { C } from "./theme";

export const TERMINAL_KEYS: { label: string; bytes: string; scroll?: boolean }[] = [
	{ label: "esc", bytes: "\x1b" },
	{ label: "⏎", bytes: "\r" },
	{ label: "/", bytes: "/" },
	{ label: "←", bytes: "\x1b[D" },
	{ label: "↑", bytes: "\x1b[A" },
	{ label: "↓", bytes: "\x1b[B" },
	{ label: "→", bytes: "\x1b[C" },
	{ label: "^C", bytes: "\x03" },
	{ label: "PgUp", bytes: "\x1b[5~", scroll: true },
	{ label: "PgDn", bytes: "\x1b[6~", scroll: true },
	{ label: "⇧tab", bytes: "\x1b[Z" },
];

export function KeyBar({
	keyboardUp,
	onKey,
	leading,
	trailing,
}: {
	/** Drops the home-indicator padding while the keyboard covers that area. */
	keyboardUp: boolean;
	/** Input keys keep the keyboard up; scroll keys (PgUp/PgDn) must not pop it. */
	onKey: (bytes: string, scroll?: boolean) => void;
	leading?: ReactNode;
	trailing?: ReactNode;
}) {
	return (
		<ScrollView
			horizontal
			showsHorizontalScrollIndicator={false}
			style={styles.keyBar}
			contentContainerStyle={[styles.keyBarContent, keyboardUp && styles.keyBarContentKeyboard]}
			keyboardShouldPersistTaps="always"
		>
			{leading}
			{TERMINAL_KEYS.map((k) => (
				<Pressable
					key={k.label}
					style={styles.key}
					onPress={() => onKey(k.bytes, k.scroll)}
					hitSlop={4}
				>
					<Text style={styles.keyText}>{k.label}</Text>
				</Pressable>
			))}
			{trailing}
		</ScrollView>
	);
}

export const keyStyles = StyleSheet.create({
	key: {
		minWidth: 44,
		height: 34,
		paddingHorizontal: 12,
		borderRadius: 8,
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
		alignItems: "center",
		justifyContent: "center",
	},
	keyText: { color: C.ink, fontSize: 14, fontWeight: "600" },
});

const styles = StyleSheet.create({
	// No maxHeight (it would clip the bottom padding). Horizontal scroll handles
	// overflow when the keys don't fit the width. Extra bottom padding lifts the row
	// off the iOS home indicator.
	keyBar: { flexGrow: 0, backgroundColor: C.surface, borderTopWidth: 1, borderTopColor: C.line },
	keyBarContent: {
		alignItems: "center",
		gap: 8,
		paddingHorizontal: 10,
		paddingTop: 8,
		paddingBottom: 30,
	},
	keyBarContentKeyboard: { paddingBottom: 8 },
	key: keyStyles.key,
	keyText: keyStyles.keyText,
});
