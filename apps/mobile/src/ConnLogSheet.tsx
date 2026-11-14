// The phone's connection log (src/conn-log.ts), to read and to share: what this
// app saw of its links, newest at the bottom, with times in UTC.
import Feather from "@expo/vector-icons/Feather";
import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { connLog } from "./conn-log";
import { C } from "./theme";

export function ConnLogSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
	const [text, setText] = useState("");
	const scroll = useRef<ScrollView>(null);
	// Read while it is open, so a drop that happens meanwhile shows as it lands.
	useEffect(() => {
		if (!visible) return;
		const read = () => setText(connLog.text());
		read();
		return connLog.subscribe(read);
	}, [visible]);
	return (
		<Modal visible={visible} animationType="slide" onRequestClose={onClose}>
			<View style={styles.root}>
				<View style={styles.header}>
					<Pressable
						style={styles.button}
						onPress={onClose}
						accessibilityRole="button"
						accessibilityLabel="Close the connection log"
					>
						<Feather name="x" size={20} color={C.ink} />
					</Pressable>
					<Text style={styles.title}>Connection log</Text>
					<Pressable
						style={[styles.button, !text && styles.disabled]}
						disabled={!text}
						onPress={() => void Share.share({ message: text })}
						accessibilityRole="button"
						accessibilityLabel="Share the connection log"
					>
						<Feather name="share" size={20} color={C.ink} />
					</Pressable>
				</View>
				<ScrollView
					ref={scroll}
					contentContainerStyle={styles.content}
					onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
				>
					<Text style={styles.note}>
						What this app saw of its connections, times in UTC. Share it when a box drops.
					</Text>
					<Text style={styles.log} selectable>
						{text || "Nothing recorded yet."}
					</Text>
				</ScrollView>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg, paddingTop: 60 },
	header: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 8,
		paddingBottom: 12,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
	},
	button: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
	disabled: { opacity: 0.4 },
	title: { color: C.ink, fontSize: 17, fontWeight: "700" },
	content: { padding: 16, paddingBottom: 40, gap: 12 },
	note: { color: C.muted, fontSize: 13, lineHeight: 18 },
	log: { color: C.ink, fontSize: 11, lineHeight: 16, fontFamily: "Menlo" },
});
