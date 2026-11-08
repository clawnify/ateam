import {
	type Alias,
	filtersSet,
	type KanbanColumn,
	type PrKey,
	type SidebarView,
	type TaskGrouping,
	type TaskSortMode,
	toggled,
} from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import { useRef, useState } from "react";
import {
	Modal,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import { C } from "./theme";

export const SIDEBAR_STATUSES: { value: KanbanColumn; label: string }[] = [
	{ value: "needs_attention", label: "Needs You" },
	{ value: "running", label: "In Progress" },
	{ value: "review", label: "Review" },
	{ value: "todo", label: "Backlog" },
	{ value: "merged", label: "Done" },
];
const GROUPINGS: { value: TaskGrouping; label: string }[] = [
	{ value: "none", label: "None" },
	{ value: "status", label: "Status" },
	{ value: "machine", label: "Machine" },
	{ value: "updated", label: "Last updated" },
];
const ORDERINGS: { value: TaskSortMode; label: string }[] = [
	{ value: "next", label: "What's next" },
	{ value: "status", label: "Status" },
	{ value: "updated", label: "Last updated" },
	{ value: "custom", label: "Custom" },
];
const PRS: { value: PrKey; label: string }[] = [
	{ value: "none", label: "No PR" },
	{ value: "open", label: "Open" },
	{ value: "merged", label: "Merged" },
	{ value: "closed", label: "Closed" },
];
type Menu = "root" | "Grouping" | "Ordering" | "Status" | "PR" | "Machine";

function Row({
	label,
	value,
	checked,
	radio,
	disabled,
	onPress,
}: {
	label: string;
	value?: string;
	checked?: boolean;
	radio?: boolean;
	disabled?: boolean;
	onPress: () => void;
}) {
	return (
		<Pressable
			style={[styles.row, disabled && styles.disabled]}
			onPress={onPress}
			disabled={disabled}
			accessibilityRole={
				Platform.OS === "ios" || checked === undefined ? "button" : radio ? "radio" : "checkbox"
			}
			accessibilityLabel={value ? `${label}: ${value}` : label}
			accessibilityState={{ checked, selected: checked, disabled }}
		>
			<Text style={styles.label}>{label}</Text>
			{value !== undefined && <Text style={styles.value}>{value}</Text>}
			{checked !== undefined ? (
				<View style={styles.check}>
					{checked && <Feather name="check" size={16} color={C.ink} />}
				</View>
			) : (
				value !== undefined && <Feather name="chevron-right" size={14} color={C.muted} />
			)}
		</Pressable>
	);
}

export function SidebarViewMenu({
	view,
	onView,
	sort,
	onSort,
	machines,
	groupKeys,
	unread,
	onMarkAllRead,
	marking,
	error,
}: {
	view: SidebarView;
	onView: (v: SidebarView) => void;
	sort: TaskSortMode;
	onSort: (s: TaskSortMode) => void;
	machines: { id: Alias; label: string }[];
	groupKeys: string[];
	unread: number;
	onMarkAllRead: () => void;
	marking: boolean;
	error?: string | null;
}) {
	const button = useRef<View>(null);
	const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
	const [menu, setMenu] = useState<Menu>("root");
	const { width, height } = useWindowDimensions();
	const lit = filtersSet(
		view,
		machines.map((m) => m.id),
	);
	const allFolded = groupKeys.length > 0 && groupKeys.every((k) => view.collapsed.includes(k));
	const maxHeight = Math.min(540, height - 80);
	return (
		<>
			<Pressable
				ref={button}
				style={styles.button}
				onPress={() => {
					setMenu("root");
					button.current?.measureInWindow((x, y, w) => setAnchor({ x: x + w + 4, y }));
				}}
				accessibilityRole="button"
				accessibilityLabel={lit ? "View options (filters on)" : "View options"}
				accessibilityState={{ expanded: anchor !== null }}
			>
				<Svg width={18} height={18} viewBox="0 0 24 24">
					<Path
						d="M3 6h18M7 12h10M10 18h4"
						fill="none"
						stroke={lit ? C.ink : C.muted}
						strokeWidth={1.75}
						strokeLinecap="round"
					/>
				</Svg>
			</Pressable>
			<Modal
				transparent
				visible={anchor !== null}
				animationType="fade"
				onRequestClose={() => setAnchor(null)}
			>
				<View style={styles.overlay}>
					<Pressable
						style={StyleSheet.absoluteFill}
						onPress={() => setAnchor(null)}
						accessibilityRole="button"
						accessibilityLabel="Close view options"
					/>
					<View
						accessibilityViewIsModal
						style={[
							styles.menu,
							{
								width: Math.min(280, width - 24),
								maxHeight,
								left: Math.max(12, Math.min(anchor?.x ?? 12, width - 292)),
								top: Math.max(40, Math.min(anchor?.y ?? 40, height - maxHeight - 20)),
							},
						]}
					>
						<View style={styles.heading}>
							{menu !== "root" && (
								<Pressable
									style={styles.back}
									onPress={() => setMenu("root")}
									accessibilityRole="button"
									accessibilityLabel="Back to view options"
								>
									<Feather name="chevron-left" size={18} color={C.ink} />
								</Pressable>
							)}
							<Text style={styles.title}>{menu === "root" ? "View options" : menu}</Text>
							<Pressable
								style={styles.back}
								onPress={() => setAnchor(null)}
								accessibilityRole="button"
								accessibilityLabel="Close view options"
							>
								<Feather name="x" size={16} color={C.muted} />
							</Pressable>
						</View>
						<ScrollView keyboardShouldPersistTaps="handled">
							{menu === "root" && (
								<>
									<Row
										label="Grouping"
										value={GROUPINGS.find((g) => g.value === view.grouping)?.label ?? "None"}
										onPress={() => setMenu("Grouping")}
									/>
									<Row
										label="Ordering"
										value={ORDERINGS.find((o) => o.value === sort)?.label ?? "Last updated"}
										onPress={() => setMenu("Ordering")}
									/>
									<Text style={styles.section}>Filters</Text>
									{(["Status", "PR", "Machine"] as const).map((m) => (
										<Row key={m} label={m} value="" onPress={() => setMenu(m)} />
									))}
									<Row
										label="Archived"
										checked={view.showArchived}
										onPress={() => onView({ ...view, showArchived: !view.showArchived })}
									/>
									<View style={styles.separator} />
									<Row
										label={allFolded ? "Expand all" : "Collapse all"}
										disabled={!groupKeys.length}
										onPress={() =>
											onView({
												...view,
												collapsed: allFolded
													? view.collapsed.filter((k) => !groupKeys.includes(k))
													: [...new Set([...view.collapsed, ...groupKeys])],
											})
										}
									/>
									<Row
										label={marking ? "Marking as read…" : "Mark all as read"}
										disabled={!unread || marking}
										onPress={onMarkAllRead}
									/>
								</>
							)}
							{menu === "Grouping" &&
								GROUPINGS.map((g) => (
									<Row
										key={g.value}
										label={g.label}
										radio
										checked={view.grouping === g.value}
										onPress={() => onView({ ...view, grouping: g.value })}
									/>
								))}
							{menu === "Ordering" && (
								<>
									{ORDERINGS.map((o) => (
										<Row
											key={o.value}
											label={o.label}
											radio
											checked={sort === o.value}
											onPress={() => onSort(o.value)}
										/>
									))}
									{sort === "custom" && (
										<Text style={styles.hint}>
											Hold a task to move it up or down within its group.
										</Text>
									)}
								</>
							)}
							{menu === "Status" &&
								SIDEBAR_STATUSES.map((s) => (
									<Row
										key={s.value}
										label={s.label}
										checked={!view.hiddenStatus.includes(s.value)}
										onPress={() =>
											onView({ ...view, hiddenStatus: toggled(view.hiddenStatus, s.value) })
										}
									/>
								))}
							{menu === "PR" &&
								PRS.map((p) => (
									<Row
										key={p.value}
										label={p.label}
										checked={!view.hiddenPr.includes(p.value)}
										onPress={() => onView({ ...view, hiddenPr: toggled(view.hiddenPr, p.value) })}
									/>
								))}
							{menu === "Machine" &&
								machines.map((m) => (
									<Row
										key={m.id ?? ""}
										label={m.label}
										checked={!view.hiddenMachines.includes(m.id)}
										onPress={() =>
											onView({ ...view, hiddenMachines: toggled(view.hiddenMachines, m.id) })
										}
									/>
								))}
						</ScrollView>
						{error && (
							<Text style={styles.hint} accessibilityRole="alert">
								{error}
							</Text>
						)}
					</View>
				</View>
			</Modal>
		</>
	);
}
const styles = StyleSheet.create({
	button: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
	overlay: { flex: 1, backgroundColor: "#00000030" },
	menu: {
		position: "absolute",
		backgroundColor: C.surface,
		borderColor: C.line,
		borderWidth: 1,
		borderRadius: 12,
		overflow: "hidden",
	},
	heading: {
		flexDirection: "row",
		alignItems: "center",
		borderBottomWidth: 1,
		borderBottomColor: C.line,
		minHeight: 44,
	},
	title: { flex: 1, color: C.ink, fontSize: 13, fontWeight: "600", paddingHorizontal: 12 },
	back: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
	row: { minHeight: 44, flexDirection: "row", alignItems: "center", paddingHorizontal: 14, gap: 8 },
	label: { flex: 1, color: C.ink, fontSize: 13 },
	value: { color: C.muted, fontSize: 12 },
	check: { width: 18 },
	disabled: { opacity: 0.4 },
	section: {
		color: C.muted,
		fontSize: 11,
		textTransform: "uppercase",
		paddingHorizontal: 14,
		paddingTop: 14,
		paddingBottom: 6,
	},
	separator: { height: 1, backgroundColor: C.line, marginVertical: 6 },
	hint: { color: C.muted, fontSize: 12, lineHeight: 18, padding: 14 },
});
