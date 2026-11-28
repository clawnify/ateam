// The project switcher: one dropdown where Home listed every project, as on the
// desktop (apps/desktop/src/renderer/src/components/ProjectSwitcher.tsx). The row
// names the selected project; its menu holds every project, then Add project.
// With no project at all, the row is the way to add one.
import Feather from "@expo/vector-icons/Feather";
import { useRef, useState } from "react";
import {
	FlatList,
	Modal,
	Platform,
	Pressable,
	type StyleProp,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
	type ViewStyle,
} from "react-native";
import type { ProjectRow } from "./HomeScreen";
import { C } from "./theme";

// Wide enough for a name beside its boxes, whatever the row's own width: the
// iPad sidebar's row is narrower than this, the phone's spans the screen.
const MENU_WIDTH = 300;
/** The least the menu keeps clear of the window's edges. */
const EDGE = 12;

export function ProjectSwitcher({
	projects,
	selectedKey,
	onSelect,
	onAdd,
	style,
}: {
	projects: ProjectRow[];
	selectedKey: string | null;
	onSelect: (key: string) => void;
	onAdd: () => void;
	style?: StyleProp<ViewStyle>;
}) {
	const row = useRef<View>(null);
	// The row's place in the window while its menu is open.
	const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
	// Add project was picked in the menu: asked for once the menu is gone, since the
	// sheet it opens never shows on iOS while a modal is still going away (as in
	// PairScanner.tsx).
	const adding = useRef(false);
	const { width, height } = useWindowDimensions();
	if (projects.length === 0)
		return (
			<Pressable
				style={({ pressed }) => [styles.row, pressed && styles.pressed, style]}
				onPress={onAdd}
				accessibilityRole="button"
				accessibilityLabel="Add project"
			>
				<Feather name="folder-plus" size={16} color={C.ink} />
				<Text style={styles.name} numberOfLines={1}>
					Add project
				</Text>
			</Pressable>
		);
	const label = projects.find((p) => p.key === selectedKey)?.name ?? "No project";
	const menuWidth = Math.min(MENU_WIDTH, width - 2 * EDGE);
	const top = Math.max(EDGE, Math.min(anchor?.y ?? 0, height - 200));
	return (
		<>
			<Pressable
				ref={row}
				style={({ pressed }) => [styles.row, pressed && styles.pressed, style]}
				onPress={() =>
					row.current?.measureInWindow((x, y, _w, h) => setAnchor({ x, y: y + h + 2 }))
				}
				accessibilityRole="button"
				accessibilityLabel={`Project: ${label}`}
				accessibilityHint="Switches project"
				accessibilityState={{ expanded: anchor !== null }}
			>
				<Text style={styles.name} numberOfLines={1}>
					{label}
				</Text>
				<Feather name="chevron-down" size={16} color={C.muted} />
			</Pressable>
			<Modal
				transparent
				visible={anchor !== null}
				animationType="fade"
				onRequestClose={() => setAnchor(null)}
				onDismiss={() => {
					if (!adding.current) return;
					adding.current = false;
					onAdd();
				}}
			>
				<View style={styles.overlay}>
					<Pressable
						style={StyleSheet.absoluteFill}
						onPress={() => setAnchor(null)}
						accessibilityRole="button"
						accessibilityLabel="Close projects"
					/>
					<View
						accessibilityViewIsModal
						onAccessibilityEscape={() => setAnchor(null)}
						style={[
							styles.menu,
							{
								width: menuWidth,
								maxHeight: height - top - 2 * EDGE,
								left: Math.max(EDGE, Math.min(anchor?.x ?? 0, width - menuWidth - EDGE)),
								top,
							},
						]}
					>
						<FlatList
							data={projects}
							keyboardShouldPersistTaps="handled"
							renderItem={({ item: p }) => {
								const active = p.key === selectedKey;
								return (
									<Pressable
										style={({ pressed }) => [styles.item, pressed && styles.pressed]}
										onPress={() => {
											setAnchor(null);
											onSelect(p.key);
										}}
										accessibilityRole="button"
										accessibilityLabel={[p.name, p.on].filter(Boolean).join(", ")}
										accessibilityState={{ selected: active }}
									>
										<Text style={styles.itemName} numberOfLines={1}>
											{p.name}
										</Text>
										{p.on ? (
											<Text style={styles.on} numberOfLines={1}>
												{p.on}
											</Text>
										) : null}
										<View style={styles.check}>
											{active && <Feather name="check" size={16} color={C.ink} />}
										</View>
									</Pressable>
								);
							}}
						/>
						{/* Under the list, not in it: in reach however many projects there are. */}
						<Pressable
							style={({ pressed }) => [styles.item, styles.add, pressed && styles.pressed]}
							onPress={() => {
								setAnchor(null);
								if (Platform.OS === "ios") adding.current = true;
								else onAdd();
							}}
							accessibilityRole="button"
						>
							<Text style={styles.itemName}>Add project…</Text>
						</Pressable>
					</View>
				</View>
			</Modal>
		</>
	);
}

const styles = StyleSheet.create({
	row: {
		minHeight: 44,
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		paddingHorizontal: 14,
		borderRadius: 8,
	},
	pressed: { backgroundColor: C.sunken },
	name: { flexShrink: 1, color: C.ink, fontSize: 15, fontWeight: "700" },
	overlay: { flex: 1, backgroundColor: "#00000030" },
	menu: {
		position: "absolute",
		backgroundColor: C.surface,
		borderColor: C.line,
		borderWidth: 1,
		borderRadius: 12,
		overflow: "hidden",
	},
	item: {
		minHeight: 44,
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 14,
		gap: 8,
	},
	itemName: { flex: 1, color: C.ink, fontSize: 15 },
	on: { flexShrink: 1, maxWidth: "45%", color: C.faint, fontSize: 12 },
	check: { width: 18 },
	add: { borderTopWidth: 1, borderTopColor: C.line },
});
