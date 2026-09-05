// Mission Control: live terminals, two per page stacked one above the other,
// in the same order as Home, paged vertically, edge to edge. Each tile attaches
// to the task's live session (never spawns one). A tap highlights a tile, and
// the shortcut bar at the bottom (esc, arrows, ^C, PgUp/PgDn) drives the
// highlighted one, so an agent can be nudged without leaving. Typing text means
// expanding to the full view, which opens with the keyboard up: the soft
// keyboard leaves two tiles no space, so typing in place was dropped.
// Like the desktop's tiles, each one sizes the PTY to itself (the last viewer
// wins): a full-screen TUI only paints right for the grid it was given, so a
// tile that kept the full view's size would show a clipped frame.
// Only the visible page's tiles are mounted, which caps open PTY streams at two.
import type { AteamApi, TaskDTO } from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import { useCallback, useRef, useState } from "react";
import {
	type LayoutChangeEvent,
	type NativeScrollEvent,
	type NativeSyntheticEvent,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import {
	type SwiftTermHandle,
	SwiftTermView,
} from "../modules/expo-swiftterm/src/ExpoSwifttermView";
import { KeyBar } from "./KeyBar";
import { TerminalStrip } from "./TerminalStrip";
import { C } from "./theme";
import { useTaskPty } from "./useTaskPty";

const PAGE_SIZE = 2;
const TILE_FONT = 9;

function Tile({
	api,
	task,
	focused,
	onFocus,
	onExpand,
	register,
}: {
	api: AteamApi;
	task: TaskDTO;
	focused: boolean;
	onFocus: () => void;
	onExpand: () => void;
	/** Hands the parent this tile's PTY writer, for the shortcut bar. */
	register: (write: (data: string) => void) => void;
}) {
	const termRef = useRef<SwiftTermHandle>(null);
	const feed = useCallback((data: string) => termRef.current?.feed(data), []);
	const pty = useTaskPty({ api, taskId: task.id, feed, spawnIfNone: false, resizePty: true });
	register(pty.write);
	return (
		<Pressable style={[styles.tile, focused && styles.tileFocused]} onPress={onFocus}>
			<TerminalStrip task={task} expanded={false} onToggle={onExpand} />
			{/* pointerEvents none: the native view never sees touches, so a tap is
			    always "highlight" and never a link, selection, or keyboard request. */}
			<View style={styles.tileBody} pointerEvents="none">
				{pty.status === "live" ? (
					<SwiftTermView
						ref={termRef}
						style={styles.term}
						fontSize={TILE_FONT}
						onSizeChange={pty.onSizeChange}
					/>
				) : (
					<Text style={styles.tileNote}>{pty.detail}</Text>
				)}
			</View>
		</Pressable>
	);
}

export function MissionScreen({
	api,
	tasks,
	onExpand,
}: {
	api: AteamApi;
	/** Tasks to tile, already ordered like Home. */
	tasks: TaskDTO[];
	onExpand: (task: TaskDTO) => void;
}) {
	const [page, setPage] = useState(0);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const { width, height } = size;
	const pagerRef = useRef<ScrollView>(null);
	// The highlighted tile, which the shortcut bar talks to.
	const [focusedId, setFocusedId] = useState<string | null>(null);
	const writers = useRef(new Map<string, (data: string) => void>());
	const pageCount = Math.max(1, Math.ceil(tasks.length / PAGE_SIZE));
	const current = Math.min(page, pageCount - 1);
	// The pager's pages take the measured size, so the stacked pair always fits
	// the screen instead of growing with its content.
	const onLayout = useCallback(
		(e: LayoutChangeEvent) =>
			setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height }),
		[],
	);
	const onScrollEnd = useCallback(
		(e: NativeSyntheticEvent<NativeScrollEvent>) => {
			if (height > 0) setPage(Math.round(e.nativeEvent.contentOffset.y / height));
		},
		[height],
	);
	// The desktop's ⌘⌥↑ / ⌘⌥↓, as buttons: flip a page and let the pager settle
	// there (onMomentumScrollEnd then records it).
	const flip = useCallback(
		(d: number) => {
			const next = Math.max(0, Math.min(pageCount - 1, current + d));
			pagerRef.current?.scrollTo({ y: next * height, animated: true });
			setPage(next);
		},
		[current, height, pageCount],
	);
	const sendKey = useCallback(
		(bytes: string) => {
			const write = focusedId ? writers.current.get(focusedId) : null;
			write?.(bytes);
		},
		[focusedId],
	);

	if (tasks.length === 0) {
		return (
			<View style={styles.empty}>
				<Text style={styles.emptyText}>No running agents on this project.</Text>
			</View>
		);
	}

	return (
		<View style={styles.root}>
			<View style={styles.pagerWrap} onLayout={onLayout}>
				{height > 0 && (
					<ScrollView
						ref={pagerRef}
						pagingEnabled
						showsVerticalScrollIndicator={false}
						onMomentumScrollEnd={onScrollEnd}
						style={styles.pager}
						keyboardShouldPersistTaps="always"
					>
						{Array.from({ length: pageCount }, (_, p) => (
							// Keyed by the page's first task, not its index, so a reordering
							// remounts the tiles that actually moved.
							<View
								key={tasks[p * PAGE_SIZE]?.id ?? "empty"}
								style={[styles.page, { width, height }]}
							>
								{/* Only the visible page mounts live tiles; the others are placeholders. */}
								{p === current
									? tasks
											.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE)
											.map((t) => (
												<Tile
													key={t.id}
													api={api}
													task={t}
													focused={t.id === focusedId}
													onFocus={() => setFocusedId(t.id)}
													onExpand={() => onExpand(t)}
													register={(write) => writers.current.set(t.id, write)}
												/>
											))
									: null}
							</View>
						))}
					</ScrollView>
				)}
				{pageCount > 1 && (
					<View style={styles.pagerCtl}>
						<Pressable
							onPress={() => flip(-1)}
							disabled={current === 0}
							style={[styles.pagerBtn, current === 0 && styles.pagerBtnOff]}
							hitSlop={6}
							accessibilityLabel="Previous terminals"
						>
							<Feather name="chevron-up" size={14} color={C.ink} />
						</Pressable>
						<Text style={styles.pagerCount}>
							{current + 1}/{pageCount}
						</Text>
						<Pressable
							onPress={() => flip(1)}
							disabled={current === pageCount - 1}
							style={[styles.pagerBtn, current === pageCount - 1 && styles.pagerBtnOff]}
							hitSlop={6}
							accessibilityLabel="Next terminals"
						>
							<Feather name="chevron-down" size={14} color={C.ink} />
						</Pressable>
					</View>
				)}
			</View>
			{/* Shortcut keys for the highlighted tile; dimmed until one is picked. */}
			<View
				style={focusedId ? undefined : styles.keysOff}
				pointerEvents={focusedId ? "auto" : "none"}
			>
				<KeyBar keyboardUp={false} onKey={sendKey} />
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: "#000" },
	pagerWrap: { flex: 1 },
	pager: { flex: 1 },
	page: {},
	// Flush tiles: no gutter, no radius; the strip is the divider.
	// A black border by default, so highlighting only recolors it and the card
	// never changes size.
	tile: {
		width: "100%",
		height: "50%",
		backgroundColor: "#000",
		borderWidth: 1,
		borderColor: "#000",
	},
	// The highlighted tile: a white edge, the app's focus color.
	tileFocused: { borderColor: C.ink },
	keysOff: { opacity: 0.4 },
	tileBody: { flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center" },
	term: { flex: 1, alignSelf: "stretch", backgroundColor: "#000" },
	tileNote: { color: C.faint, fontSize: 11, padding: 8, textAlign: "center" },
	// The desktop's mcpager: bottom-right, a column of up / count / down, faded
	// until needed.
	pagerCtl: {
		position: "absolute",
		right: 14,
		bottom: 14,
		alignItems: "center",
		padding: 3,
		backgroundColor: C.surface,
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 9,
		opacity: 0.7,
	},
	pagerBtn: { width: 26, height: 22, alignItems: "center", justifyContent: "center" },
	pagerBtnOff: { opacity: 0.35 },
	pagerCount: { color: C.muted, fontSize: 10, fontVariant: ["tabular-nums"], paddingVertical: 2 },
	empty: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: C.bg },
	emptyText: { color: C.faint, fontSize: 13 },
});
