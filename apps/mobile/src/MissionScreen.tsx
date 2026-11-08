// Desktop and native share geometry, capacity, priority, and session selection.
// Only the visible page attaches terminals. Opening this overview never restores
// or launches an agent; it watches sessions that are already live.
import {
	bestMcShape,
	fixedMcShape,
	MC_CHOICES,
	MC_PAGE_SIZE,
	MC_REORDER_DELAY_MS,
	MC_RESIZE_SETTLE_MS,
	type McArea,
	type McChoice,
	mcCapacity,
	mcShapeRects,
} from "@ateam/panes";
import {
	activeTerminal,
	type AgentDTO,
	type AteamApi,
	byMcPriority,
	sessionTabs,
	type SessionDTO,
	stabilizeMcPages,
	type TaskDTO,
	tileSessions,
} from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
	type SwiftTermHandle,
	SwiftTermView,
} from "../modules/expo-swiftterm/src/ExpoSwifttermView";
import { KeyBar } from "./KeyBar";
import { MC_NATIVE_FONT_SIZE, MC_NATIVE_METRICS } from "./mission-metrics";
import { MissionLayoutIcon } from "./MissionLayoutIcon";
import { TerminalStrip } from "./TerminalStrip";
import { C } from "./theme";
import { usePty } from "./useTaskPty";

type LiveTile = { task: TaskDTO; sessions: SessionDTO[] };
type Writer = (data: string) => void;

/** Kept by Shell while a terminal covers Mission Control, separately per scope. */
export interface MissionViewState {
	layout?: McChoice;
	page?: number;
	focusedId?: string | null;
	order?: string[];
	sessions: Record<string, string>;
}

function LiveTerminal({
	api,
	terminalId,
	register,
}: {
	api: AteamApi;
	terminalId: string;
	register: (write: Writer | null) => void;
}) {
	const termRef = useRef<SwiftTermHandle>(null);
	const feed = useCallback((data: string) => termRef.current?.feed(data), []);
	const open = useCallback(async () => terminalId, [terminalId]);
	const pty = usePty({ api, open, feed, resizePty: true });
	useEffect(() => {
		register(pty.write);
		return () => register(null);
	}, [pty.write, register]);
	return (
		<View style={styles.tileBody} pointerEvents="none">
			{pty.status === "live" ? (
				<SwiftTermView
					ref={termRef}
					style={styles.term}
					fontSize={MC_NATIVE_FONT_SIZE}
					onSizeChange={pty.onSizeChange}
				/>
			) : (
				<Text style={styles.note}>{pty.detail}</Text>
			)}
		</View>
	);
}

function Tile({
	api,
	task,
	sessions,
	agents,
	focused,
	onFocus,
	onExpand,
	writers,
	memory,
}: {
	api: AteamApi;
	task: TaskDTO;
	sessions: SessionDTO[];
	agents: AgentDTO[];
	focused: boolean;
	onFocus: () => void;
	onExpand: (session: SessionDTO) => void;
	writers: Map<string, Writer>;
	memory: MissionViewState;
}) {
	// Hold the arrival's tab: activity on another session must not switch it.
	const [picked, setPicked] = useState(() =>
		activeTerminal(sessions, memory.sessions[task.id] ?? null),
	);
	const shown = activeTerminal(sessions, picked);
	useEffect(() => {
		if (shown !== picked) setPicked(shown);
	}, [shown, picked]);
	const register = useCallback(
		(write: Writer | null) => {
			if (write) writers.set(task.id, write);
			else writers.delete(task.id);
		},
		[writers, task.id],
	);
	return (
		<View style={[styles.tile, focused && styles.tileFocused]}>
			<TerminalStrip
				task={task}
				expanded={false}
				onToggle={() => {
					const session = sessions.find((s) => s.terminalId === shown);
					if (session) {
						memory.sessions[task.id] = session.terminalId;
						onExpand(session);
					}
				}}
			/>
			{sessions.length > 1 && (
				<ScrollView horizontal style={styles.sessions} contentContainerStyle={styles.sessionRow}>
					{sessionTabs(sessions, agents).map(({ session, label }) => (
						<Pressable
							key={session.terminalId}
							style={styles.session}
							accessibilityRole="button"
							accessibilityLabel={`${task.name}: ${label}`}
							accessibilityState={{ selected: shown === session.terminalId }}
							onPress={() => {
								memory.sessions[task.id] = session.terminalId;
								setPicked(session.terminalId);
								onFocus();
							}}
						>
							<Text style={[styles.controlText, shown === session.terminalId && styles.selected]}>
								{label}
							</Text>
						</Pressable>
					))}
				</ScrollView>
			)}
			<Pressable
				style={styles.terminalHit}
				onPress={onFocus}
				accessibilityRole="button"
				accessibilityLabel={`Select ${task.name}`}
				accessibilityState={{ selected: focused }}
			>
				{shown && <LiveTerminal key={shown} api={api} terminalId={shown} register={register} />}
			</Pressable>
		</View>
	);
}

export function MissionScreen({
	api,
	tasks,
	agents,
	scope,
	mode,
	onMode,
	onExpand,
	jump,
	onJumpMissing,
	memory,
}: {
	api: AteamApi;
	tasks: TaskDTO[];
	agents: AgentDTO[];
	scope: string;
	mode: "tasks" | "loops";
	onMode: (mode: "tasks" | "loops") => void;
	onExpand: (task: TaskDTO, session: SessionDTO) => void;
	jump: { id: string; seq: number } | null;
	onJumpMissing: (taskId: string) => void;
	memory: MissionViewState;
}) {
	const [layout, setLayout] = useState<McChoice>(memory.layout ?? "auto");
	const [page, setPage] = useState(memory.page ?? 0);
	const [size, setSize] = useState<McArea>({ width: 0, height: 0 });
	const [fit, setFit] = useState<{ area: McArea; capacity: number } | null>(null);
	const [placed, setPlaced] = useState<LiveTile[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [syncSeq, setSyncSeq] = useState(0);
	const [focusedId, setFocusedId] = useState<string | null>(memory.focusedId ?? null);
	const [settled, setSettled] = useState({ requested: "", order: memory.order?.join(" ") ?? "" });
	const writers = useRef(new Map<string, Writer>());
	const pagerRef = useRef<ScrollView>(null);
	const layoutChosen = useRef(false);
	const layoutKey = `ateam.mcLayout.${scope}.${mode}`;
	const resetOrder = useRef(!memory.order?.length);
	const tasksRef = useRef(tasks);
	tasksRef.current = tasks;

	useEffect(() => {
		let cancelled = false;
		void AsyncStorage.getItem(layoutKey)
			.then((saved) => {
				if (!cancelled && !layoutChosen.current && MC_CHOICES.some((c) => c.value === saved)) {
					memory.layout = saved as McChoice;
					setLayout(saved as McChoice);
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [layoutKey, memory]);

	useEffect(() => {
		if (!size.width || !size.height) return;
		const timer = setTimeout(
			() =>
				setFit((prev) => ({
					area: size,
					capacity: mcCapacity(size, prev?.capacity, MC_NATIVE_METRICS),
				})),
			MC_RESIZE_SETTLE_MS,
		);
		return () => clearTimeout(timer);
	}, [size]);

	// Session discovery owns membership; current task props own status/recency.
	// Preserve existing slots on arrival/exit, and snapshot list order on Refresh.
	const taskIds = tasks
		.map((t) => t.id)
		.sort()
		.join(" ");
	// biome-ignore lint/correctness/useExhaustiveDependencies: explicit refresh and membership trigger discovery; metadata is read from the ref.
	useEffect(() => {
		let cancelled = false;
		let running = false;
		let again = false;
		const refresh = async () => {
			if (running) {
				again = true;
				return;
			}
			running = true;
			do {
				again = false;
				const requestedTasks = tasksRef.current;
				const results = await Promise.allSettled(
					requestedTasks.map(async (task) => ({
						task,
						sessions: tileSessions(await api.pty.listForTask(task.id)).reverse(),
					})),
				);
				if (cancelled) return;
				const live = results.flatMap((r) =>
					r.status === "fulfilled" && r.value.sessions.length ? [r.value] : [],
				);
				const failed = new Set(
					results.flatMap((r, i) => (r.status === "rejected" ? [requestedTasks[i]?.id] : [])),
				);
				const reset = resetOrder.current;
				resetOrder.current = false;
				setPlaced((prev) => {
					const found = new Map(live.map((t) => [t.task.id, t]));
					for (const t of prev) if (failed.has(t.task.id)) found.set(t.task.id, t);
					const ids = reset
						? tasksRef.current.map((t) => t.id)
						: prev.length
							? prev.map((t) => t.task.id)
							: (memory.order ?? []);
					const kept = ids.flatMap((id) => {
						const t = found.get(id);
						found.delete(id);
						return t ? [t] : [];
					});
					return [...kept, ...found.values()];
				});
				setError(failed.size ? "Some machines could not be reached. Refresh to retry." : null);
				setLoaded(true);
			} while (again && !cancelled);
			running = false;
		};
		void refresh();
		const offTask = api.events.onTaskUpdated(() => void refresh());
		const offExit = api.pty.onExit(() => void refresh());
		return () => {
			cancelled = true;
			offTask();
			offExit();
		};
	}, [api, taskIds, syncSeq]);

	const fresh = useMemo(() => {
		const current = new Map(tasks.map((t) => [t.id, t]));
		return placed.flatMap((tile) => {
			const task = current.get(tile.task.id);
			return task ? [{ ...tile, task }] : [];
		});
	}, [placed, tasks]);
	const priorityOrder = [...fresh]
		.sort((a, b) => byMcPriority(a.task, b.task))
		.map((t) => t.task.id)
		.join(" ");
	const initialOrder = useRef(memory.order?.join(" "));
	const priorityRef = useRef(priorityOrder);
	priorityRef.current = priorityOrder;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the user explicitly requests fresh ordering with layout or Refresh.
	useEffect(() => {
		const requested = priorityRef.current;
		const order = initialOrder.current ?? requested;
		initialOrder.current = undefined;
		setSettled({ requested, order });
	}, [layout, syncSeq]);
	const rank = new Map((settled.order || priorityOrder).split(" ").map((id, i) => [id, i]));
	const tiles =
		layout === "auto"
			? [...fresh].sort(
					(a, b) => (rank.get(a.task.id) ?? Infinity) - (rank.get(b.task.id) ?? Infinity),
				)
			: fresh;
	const pageSize = layout === "auto" ? (fit?.capacity ?? 1) : MC_PAGE_SIZE[layout];
	const pageCount = Math.max(1, Math.ceil(tiles.length / pageSize));
	const current = Math.min(page, pageCount - 1);
	const tilesRef = useRef(tiles);
	tilesRef.current = tiles;
	const pageSizeRef = useRef(pageSize);
	pageSizeRef.current = pageSize;
	useEffect(() => {
		if (!loaded || layout !== "auto" || settled.requested === priorityOrder) return;
		if (!settled.order || !priorityOrder) {
			setSettled({ requested: priorityOrder, order: priorityOrder });
			return;
		}
		const timer = setTimeout(() => {
			const order = stabilizeMcPages(
				priorityOrder.split(" "),
				tilesRef.current.map((t) => t.task.id),
				pageSizeRef.current,
			).join(" ");
			setSettled({ requested: priorityOrder, order });
		}, MC_REORDER_DELAY_MS);
		return () => clearTimeout(timer);
	}, [loaded, layout, settled, priorityOrder]);

	const ready = loaded && fit !== null;
	useEffect(() => {
		if (!ready) return;
		setPage(current);
		pagerRef.current?.scrollTo({ y: current * size.height, animated: false });
	}, [current, size.height, ready]);
	const displayedOrder = tiles.map((t) => t.task.id).join(" ");
	useEffect(() => {
		if (!ready) return;
		memory.page = current;
		memory.focusedId = focusedId;
		memory.order = displayedOrder ? displayedOrder.split(" ") : [];
	}, [ready, current, focusedId, displayedOrder, memory]);
	const handledJump = useRef<number | null>(null);
	useEffect(() => {
		if (!jump || !ready || handledJump.current === jump.seq) return;
		handledJump.current = jump.seq;
		const index = tiles.findIndex((t) => t.task.id === jump.id);
		if (index >= 0) {
			setPage(Math.floor(index / pageSize));
			setFocusedId(jump.id);
		} else {
			onJumpMissing(jump.id);
		}
	}, [jump, ready, tiles, pageSize, onJumpMissing]);

	const visible = tiles.slice(current * pageSize, (current + 1) * pageSize);
	const focusedVisible = visible.some((t) => t.task.id === focusedId);
	const cycleLayout = () => {
		const index = MC_CHOICES.findIndex((c) => c.value === layout);
		const next = MC_CHOICES[(index + 1) % MC_CHOICES.length]?.value ?? "auto";
		layoutChosen.current = true;
		memory.layout = next;
		setLayout(next);
		setPage(0);
		void AsyncStorage.setItem(layoutKey, next).catch(() => {});
	};
	const shape =
		layout === "auto"
			? bestMcShape(visible.length, fit?.area ?? size, MC_NATIVE_METRICS)
			: fixedMcShape(layout);
	const rects = mcShapeRects(shape, size);
	return (
		<View style={styles.root}>
			<View style={styles.controls}>
				{(["tasks", "loops"] as const).map((m) => (
					<Pressable
						key={m}
						style={styles.control}
						onPress={() => onMode(m)}
						accessibilityRole="button"
						accessibilityLabel={`Mission Control ${m}`}
						accessibilityState={{ selected: mode === m }}
					>
						<Text style={[styles.controlText, mode === m && styles.selected]}>
							{m === "tasks" ? "Tasks" : "Loops"}
						</Text>
					</Pressable>
				))}
				<View style={styles.spacer} />
				<Pressable
					style={styles.control}
					onPress={cycleLayout}
					accessibilityRole="button"
					accessibilityLabel={`Mission Control layout: ${MC_CHOICES.find((c) => c.value === layout)?.label}`}
					accessibilityHint="Tap to switch to the next layout"
				>
					<MissionLayoutIcon layout={layout} color={C.ink} />
				</Pressable>
				<Pressable
					style={styles.control}
					onPress={() => {
						resetOrder.current = true;
						setSyncSeq((s) => s + 1);
					}}
					accessibilityRole="button"
					accessibilityLabel="Refresh Mission Control"
				>
					<Feather name="refresh-cw" size={16} color={C.ink} />
				</Pressable>
			</View>
			{error && <Text style={styles.note}>{error}</Text>}
			<View
				style={styles.pagerWrap}
				onLayout={(e) => {
					const { width, height } = e.nativeEvent.layout;
					setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
				}}
			>
				{!tiles.length ? (
					<View style={styles.empty}>
						<Text style={styles.note}>
							{loaded ? `No running agents in ${mode}.` : "Finding live sessions…"}
						</Text>
					</View>
				) : (
					size.height > 0 &&
					fit && (
						<ScrollView
							ref={pagerRef}
							pagingEnabled
							showsVerticalScrollIndicator={false}
							onMomentumScrollEnd={(e) =>
								setPage(
									Math.max(
										0,
										Math.min(
											pageCount - 1,
											Math.round(e.nativeEvent.contentOffset.y / size.height),
										),
									),
								)
							}
							style={styles.pager}
							keyboardShouldPersistTaps="always"
						>
							{Array.from({ length: pageCount }, (_, p) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: page numbers are stable slots, not task identities.
								<View key={p} style={size}>
									{p === current &&
										visible.map(({ task, sessions }, i) => (
											<View key={task.id} style={[styles.frame, rects[i]]}>
												<Tile
													api={api}
													task={task}
													sessions={sessions}
													agents={agents}
													focused={task.id === focusedId}
													onFocus={() => setFocusedId(task.id)}
													onExpand={(session) => onExpand(task, session)}
													writers={writers.current}
													memory={memory}
												/>
											</View>
										))}
								</View>
							))}
						</ScrollView>
					)
				)}
				{pageCount > 1 && (
					<View style={styles.pagerCtl}>
						<Pressable
							style={styles.pagerBtn}
							disabled={current === 0}
							onPress={() => setPage(current - 1)}
							accessibilityRole="button"
							accessibilityLabel="Previous terminals"
							accessibilityState={{ disabled: current === 0 }}
						>
							<Feather name="chevron-up" size={18} color={current === 0 ? C.faint : C.ink} />
						</Pressable>
						<Text style={styles.controlText}>
							{current + 1}/{pageCount}
						</Text>
						<Pressable
							style={styles.pagerBtn}
							disabled={current === pageCount - 1}
							onPress={() => setPage(current + 1)}
							accessibilityRole="button"
							accessibilityLabel="Next terminals"
							accessibilityState={{ disabled: current === pageCount - 1 }}
						>
							<Feather
								name="chevron-down"
								size={18}
								color={current === pageCount - 1 ? C.faint : C.ink}
							/>
						</Pressable>
					</View>
				)}
			</View>
			<View
				style={focusedVisible ? undefined : styles.keysOff}
				pointerEvents={focusedVisible ? "auto" : "none"}
			>
				<KeyBar
					keyboardUp={false}
					onKey={(bytes) => {
						if (focusedVisible && focusedId) writers.current.get(focusedId)?.(bytes);
					}}
				/>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: "#000" },
	controls: {
		flexDirection: "row",
		alignItems: "center",
		backgroundColor: C.surface,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
		paddingHorizontal: 4,
	},
	control: {
		minWidth: 44,
		minHeight: 44,
		paddingHorizontal: 10,
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		gap: 6,
	},
	controlText: { color: C.muted, fontSize: 12 },
	selected: { color: C.ink, fontWeight: "700" },
	spacer: { flex: 1 },
	pagerWrap: { flex: 1 },
	pager: { flex: 1 },
	frame: { position: "absolute" },
	tile: { flex: 1, backgroundColor: "#000", borderWidth: 1, borderColor: "#000" },
	tileFocused: { borderColor: C.ink },
	sessions: { flexGrow: 0, maxHeight: 44, backgroundColor: C.surface },
	sessionRow: { alignItems: "center" },
	session: { minHeight: 44, paddingHorizontal: 12, justifyContent: "center" },
	keysOff: { opacity: 0.4 },
	terminalHit: { flex: 1 },
	tileBody: { flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center" },
	term: { flex: 1, alignSelf: "stretch", backgroundColor: "#000" },
	note: { color: C.faint, fontSize: 12, padding: 8, textAlign: "center" },
	pagerCtl: {
		position: "absolute",
		right: 12,
		bottom: 12,
		alignItems: "center",
		backgroundColor: C.surface,
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 9,
		opacity: 0.9,
	},
	pagerBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
	empty: { flex: 1, alignItems: "center", justifyContent: "center" },
});
