// Top-level tabs in the header, where the project dropdown used to sit: a pill
// nav in the classic iOS style. A dark rounded track; the active tab is a white
// pill with its icon and label, the others show their icon only.
import Feather from "@expo/vector-icons/Feather";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { C } from "./theme";

export type Tab = "home" | "board" | "mission" | "loops";

const TABS: { key: Tab; label: string; icon: "home" | "columns" | "grid" | "repeat" }[] = [
	{ key: "home", label: "Home", icon: "home" },
	{ key: "board", label: "Board", icon: "columns" },
	{ key: "mission", label: "Mission", icon: "grid" },
	{ key: "loops", label: "Loops", icon: "repeat" },
];

const INK_ON_WHITE = "#15151a";

export function TabStrip({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
	return (
		<View style={styles.track}>
			{TABS.map((t) => {
				const active = t.key === tab;
				return (
					<Pressable
						key={t.key}
						style={[styles.segment, active && styles.segmentActive]}
						onPress={() => onChange(t.key)}
						accessibilityRole="tab"
						accessibilityLabel={t.label}
						accessibilityState={{ selected: active }}
						hitSlop={4}
					>
						<Feather name={t.icon} size={16} color={active ? INK_ON_WHITE : C.ink} />
						{active && (
							<Text style={styles.label} numberOfLines={1}>
								{t.label}
							</Text>
						)}
					</Pressable>
				);
			})}
		</View>
	);
}

const styles = StyleSheet.create({
	track: {
		flexDirection: "row",
		alignItems: "center",
		alignSelf: "center",
		backgroundColor: C.sunken,
		borderRadius: 999,
		padding: 4,
		gap: 2,
	},
	segment: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		gap: 6,
		height: 34,
		minWidth: 40,
		paddingHorizontal: 12,
		borderRadius: 999,
	},
	segmentActive: {
		backgroundColor: C.ink,
		paddingHorizontal: 14,
	},
	label: { color: INK_ON_WHITE, fontSize: 14, fontWeight: "700" },
});
