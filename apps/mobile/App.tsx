// Ateam mobile — a thin remote for a box running the Ateam engine. The phone
// opens a WebSocket to the box's opt-in `ateam` WS listener (over Tailscale),
// handshakes, and drives the SAME engine the desktop does via the shared
// @ateam/protocol contract (see src/connection.ts). The board is LIVE and the
// composer creates + launches tasks on the box; tapping a task opens its terminal.
//
// Theme = Ateam's real tokens (apps/desktop/src/renderer/src/index.css): near-black
// #0c0c0e canvas, ink/white for the primary action and every highlight (no accent
// hue), amber/blue/green status. Connection = ALWAYS a WebSocket to a Tailscale address (RN can't spawn
// ssh; WireGuard is the auth boundary).
import type { AgentDTO, AteamApi, LoopDTO, ProjectDTO, TaskDTO } from "@ateam/protocol";
import { PROTOCOL_VERSION } from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	AppState,
	KeyboardAvoidingView,
	Linking,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	StatusBar,
	StyleSheet,
	Text,
	TextInput,
	useColorScheme,
	View,
} from "react-native";
import { AgentIcon } from "./src/AgentIcon";
import { Composer, type ComposerSubmit } from "./src/Composer";
import { ConsentScreen } from "./src/ConsentScreen";
import { type Connection, connect } from "./src/connection";
import { demoConnection } from "./src/demo";
import { HomeScreen } from "./src/HomeScreen";
import { LoopForm, LoopsScreen } from "./src/LoopsScreen";
import { MissionScreen } from "./src/MissionScreen";
import { NativeTerminalScreen } from "./src/NativeTerminalScreen";
import { ProjectBrowser } from "./src/ProjectBrowser";
import {
	loadConnection,
	loadConsent,
	loadDismissedSkew,
	loadPreviewPort,
	loadSelectedProject,
	saveConnection,
	saveConsent,
	saveDismissedSkew,
	savePreviewPort,
	saveSelectedProject,
} from "./src/storage";
import { type Tab, TabStrip } from "./src/TabStrip";
import { TerminalScreen } from "./src/TerminalScreen";
import { sortTasks } from "./src/task-order";

// SPIKE flag: evaluate the native SwiftTerm terminal (native scroll/select/copy)
// vs the xterm-in-webview one. Flip back to false to fall back to the webview.
const USE_NATIVE_TERMINAL = true;
const Term = USE_NATIVE_TERMINAL ? NativeTerminalScreen : TerminalScreen;

const C = {
	bg: "#0c0c0e",
	surface: "#141418",
	sunken: "#1c1c22",
	line: "#2a2a33",
	ink: "#e6e6ea",
	muted: "#9a9aa6",
	faint: "#6a6a75",
	green: "#4ade80",
	amber: "#fbbf24",
	red: "#f87171",
	blue: "#60a5fa",
};

const TINT: Record<string, string> = {
	[C.amber]: "rgba(251,191,36,0.13)",
	[C.ink]: "rgba(230,230,234,0.12)",
	[C.blue]: "rgba(96,165,250,0.14)",
	[C.green]: "rgba(74,222,128,0.13)",
	[C.muted]: "rgba(154,154,166,0.12)",
	[C.red]: "rgba(248,113,113,0.14)",
};

const COLUMNS: { key: TaskDTO["column"]; label: string; tint: string }[] = [
	{ key: "needs_attention", label: "Needs You", tint: C.amber },
	{ key: "running", label: "In Progress", tint: C.ink },
	{ key: "review", label: "Review", tint: C.blue },
	{ key: "todo", label: "Backlog", tint: C.muted },
	{ key: "merged", label: "Done", tint: C.green },
];

// Cap the phone-first content to a comfortable reading column and center it. A no-op
// on iPhone (wider than any screen), it stops the board/composer/form from stretching
// edge-to-edge on iPad. The terminal is intentionally exempt — more columns is better.
const CONTENT_MAX = 720;

function taskNote(t: TaskDTO): string {
	if (t.column === "needs_attention") return "awaiting your input";
	if (t.agentStatus === "running") return "running";
	if (t.mergeStatus) return t.mergeStatus;
	if (t.prNumber != null) return `PR #${t.prNumber}`;
	const dirty = t.gitStatus?.dirty ?? 0;
	if (dirty > 0) return `${dirty} changed`;
	return t.agentStatus ?? "idle";
}

/** Readable task name from the prompt's first words (mirrors the desktop). */
function titleFromPrompt(p: string): string {
	return p.trim().split(/\s+/).slice(0, 6).join(" ").slice(0, 60);
}

function LogoMark() {
	return (
		<View style={styles.logo}>
			<View style={styles.logoTop} />
			<View style={styles.logoBottom}>
				<View style={[styles.logoSq, { opacity: 0.85 }]} />
				<View style={[styles.logoSq, { opacity: 0.6 }]} />
			</View>
		</View>
	);
}

function Chip({ children }: { children: string }) {
	return (
		<View style={styles.chip}>
			<Text style={styles.chipText} numberOfLines={1}>
				{children}
			</Text>
		</View>
	);
}

function Badge({ children, tint }: { children: string; tint: string }) {
	return (
		<View style={[styles.badge, { backgroundColor: TINT[tint] ?? C.sunken }]}>
			<Text style={[styles.badgeText, { color: tint }]} numberOfLines={1}>
				{children}
			</Text>
		</View>
	);
}

function AgentTag({ agent }: { agent: string }) {
	const known = agent === "claude" || agent === "codex" || agent === "opencode";
	return (
		<View style={styles.agentTag}>
			{known ? (
				<AgentIcon agentId={agent} size={14} />
			) : (
				<Text style={styles.agentInitial}>{agent[0]?.toUpperCase() ?? "·"}</Text>
			)}
		</View>
	);
}

function TaskCard({ task, tint, onOpen }: { task: TaskDTO; tint: string; onOpen: () => void }) {
	return (
		<Pressable style={styles.card} onPress={onOpen} hitSlop={2}>
			<View style={styles.cardTop}>
				<AgentTag agent={task.agentId ?? "·"} />
				<Text style={styles.cardName} numberOfLines={2}>
					{task.name}
				</Text>
			</View>
			<View style={styles.cardMeta}>
				<Chip>{task.branch}</Chip>
				<Badge tint={tint}>{taskNote(task)}</Badge>
			</View>
		</Pressable>
	);
}

// ── Connection screen — the box's WebSocket target; back/Disconnect when live ──

function Field({
	label,
	value,
	onChangeText,
	placeholder,
	keyboardType,
	last,
}: {
	label: string;
	value: string;
	onChangeText: (t: string) => void;
	placeholder: string;
	keyboardType?: "default" | "numeric";
	last?: boolean;
}) {
	return (
		<View style={[styles.fieldRow, !last && styles.fieldDivider]}>
			<Text style={styles.fieldLabel}>{label}</Text>
			<TextInput
				style={styles.fieldInput}
				value={value}
				onChangeText={onChangeText}
				placeholder={placeholder}
				placeholderTextColor={C.faint}
				autoCapitalize="none"
				autoCorrect={false}
				keyboardType={keyboardType ?? "default"}
			/>
		</View>
	);
}

function ConnectionScreen({
	host,
	port,
	setHost,
	setPort,
	onConnect,
	onBack,
	onDisconnect,
	onDemo,
	connecting,
	connected,
	error,
}: {
	host: string;
	port: string;
	setHost: (t: string) => void;
	setPort: (t: string) => void;
	onConnect: () => void;
	onBack: () => void;
	onDisconnect: () => void;
	onDemo: () => void;
	connecting: boolean;
	connected: boolean;
	error: string | null;
}) {
	return (
		<View style={styles.root}>
			<StatusBar barStyle="light-content" backgroundColor={C.bg} />
			<View style={styles.navBar}>
				{connected ? (
					<Pressable onPress={onBack} hitSlop={8}>
						<Text style={styles.backText}>‹ Board</Text>
					</Pressable>
				) : (
					<LogoMark />
				)}
				<Text style={styles.navTitle}>{connected ? "Connection" : "New connection"}</Text>
				<View style={styles.spacer} />
				<Pressable
					style={[styles.connectBtn, connecting && styles.connectBtnBusy]}
					onPress={onConnect}
					disabled={connecting}
					hitSlop={6}
				>
					{connecting ? (
						<ActivityIndicator color="#15151a" size="small" />
					) : (
						<Text style={styles.connectBtnText}>{connected ? "Reconnect" : "Connect"}</Text>
					)}
				</Pressable>
			</View>

			<ScrollView contentContainerStyle={styles.formContent} showsVerticalScrollIndicator={false}>
				<View style={styles.contentColumn}>
					<View style={styles.eyebrowRow}>
						<View style={[styles.tick, { backgroundColor: C.ink }]} />
						<Text style={styles.eyebrow}>Box</Text>
					</View>
					<View style={styles.formCard}>
						<Field
							label="Tailscale IP or host"
							value={host}
							onChangeText={setHost}
							placeholder="100.x.y.z"
						/>
						<Field
							label="Port"
							value={port}
							onChangeText={setPort}
							placeholder="8787"
							keyboardType="numeric"
							last
						/>
					</View>

					{!connected ? (
						<View style={styles.demoRow}>
							<View style={styles.demoRule} />
							<Text style={styles.demoOr}>or</Text>
							<View style={styles.demoRule} />
						</View>
					) : null}
					{!connected ? (
						<Pressable style={styles.demoBtn} onPress={onDemo} hitSlop={6}>
							<Text style={styles.demoText}>Try the demo — no box needed</Text>
						</Pressable>
					) : null}

					{error ? (
						<View style={styles.errorBox}>
							<Text style={styles.errorText}>{error}</Text>
						</View>
					) : null}

					{connected ? (
						<Pressable style={styles.disconnectBtn} onPress={onDisconnect} hitSlop={6}>
							<Text style={styles.disconnectText}>Disconnect</Text>
						</Pressable>
					) : null}

					<Text style={styles.formNote}>
						The phone opens a WebSocket to your box's `ateam` listener over Tailscale — WireGuard is
						the encryption and the auth boundary. Enable it on the box with{" "}
						<Text style={styles.mono}>ATEAM_WS_ADDR=&lt;tailscale-ip&gt;:&lt;port&gt;</Text>.
					</Text>
				</View>
			</ScrollView>
		</View>
	);
}

// ── Dev-server preview — open http://<box>:<port> in the phone browser ──
// No tunnel needed: the phone is already on the tailnet, so the box's dev server
// is directly reachable at the same host we connected to. Port is user-set (default
// 3000) and remembered. See issue #73.

function PreviewModal({
	visible,
	host,
	port,
	setPort,
	onOpen,
	onClose,
}: {
	visible: boolean;
	host: string | null;
	port: string;
	setPort: (t: string) => void;
	onOpen: () => void;
	onClose: () => void;
}) {
	return (
		<Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
			<Pressable style={styles.modalBackdrop} onPress={onClose}>
				{/* Inner Pressable swallows taps so touching the card doesn't dismiss it. */}
				<Pressable style={styles.previewCard} onPress={() => {}}>
					<Text style={styles.previewTitle}>Open preview</Text>
					<Text style={styles.previewSub}>
						Opens a dev server running on the box in your browser, over Tailscale.
					</Text>
					<View style={styles.previewUrlRow}>
						<Text style={styles.previewUrlText} numberOfLines={1}>
							http://{host ?? "—"}:
						</Text>
						<TextInput
							style={styles.previewPortInput}
							value={port}
							onChangeText={setPort}
							placeholder="3000"
							placeholderTextColor={C.faint}
							keyboardType="numeric"
							autoFocus
							selectTextOnFocus
						/>
					</View>
					<Pressable
						style={[styles.previewOpenBtn, !host && styles.previewOpenBtnDisabled]}
						onPress={onOpen}
						disabled={!host}
						hitSlop={6}
					>
						<Text style={styles.previewOpenText}>Open in browser</Text>
					</Pressable>
				</Pressable>
			</Pressable>
		</Modal>
	);
}

// ── Shell — status dot (left) · tab pill (center) · one of Home / Board / Mission
// Control / Loops below, or the open task's terminal in their place ──

function Shell({
	connColor,
	projects,
	selectedProjectId,
	onSelectProject,
	agents,
	tasks,
	loading,
	creating,
	onOpenConnection,
	onOpenTask,
	onCreate,
	onAddProject,
	skew,
	updating,
	updateError,
	boxAtLatest,
	onUpdateBox,
	api,
	tab,
	onTab,
	loops,
	onNewLoop,
	onEditLoop,
	onLoopsChanged,
	openTask,
	openTaskFocus,
	onCloseTask,
	onExpandTask,
	onDismissSkew,
	connGen,
}: {
	connColor: string;
	projects: ProjectDTO[];
	selectedProjectId: string | null;
	onSelectProject: (id: string) => void;
	agents: AgentDTO[];
	tasks: TaskDTO[];
	loading: boolean;
	creating: boolean;
	onOpenConnection: () => void;
	onOpenTask: (task: TaskDTO) => void;
	onCreate: (input: ComposerSubmit) => void;
	onAddProject: () => void;
	/** The box's protocol when it differs from this app's; null when they match. */
	skew: number | null;
	updating: boolean;
	/** Why the last update attempt failed. Cleared at the start of the next one. */
	updateError: string | null;
	/** An update came back on the same version: the box already runs the newest
	 *  release, and it's this app that is ahead of it. */
	boxAtLatest: boolean;
	onUpdateBox: () => void;
	api: AteamApi;
	tab: Tab;
	onTab: (tab: Tab) => void;
	/** The selected project's loops. */
	loops: LoopDTO[];
	onNewLoop: () => void;
	onEditLoop: (loop: LoopDTO) => void;
	onLoopsChanged: (loops: LoopDTO[]) => void;
	/** The task whose terminal fills the view under the navbar, if any. */
	openTask: TaskDTO | null;
	/** Whether that terminal should open with the keyboard up (expanded from a tile). */
	openTaskFocus: boolean;
	onCloseTask: () => void;
	/** Expand a Mission Control tile: open its terminal ready to type. */
	onExpandTask: (task: TaskDTO) => void;
	/** Hide the version banner for this box version (it returns when the version changes). */
	onDismissSkew: () => void;
	/** Keys the terminal so an auto-reattach remounts it onto the fresh api. */
	connGen: number;
}) {
	const shown = tasks.filter((t) => t.projectId === selectedProjectId);
	// Mission Control tiles: this project's tasks that have (or had) an agent, in
	// Home's order, merged work excluded.
	const missionTasks = sortTasks(
		shown.filter((t) => t.column !== "merged" && t.agentStatus !== null),
		"status",
	);
	return (
		<KeyboardAvoidingView
			style={styles.root}
			behavior={Platform.OS === "ios" ? "padding" : undefined}
		>
			<StatusBar barStyle="light-content" backgroundColor={C.bg} />
			<View style={styles.boardHeader}>
				<Pressable style={styles.statusHit} onPress={onOpenConnection} hitSlop={10}>
					<View style={[styles.statusDot, { backgroundColor: connColor }]} />
				</Pressable>
				<View style={styles.headerCenter}>
					<TabStrip
						tab={tab}
						onChange={(t) => {
							// A tab tap from the full terminal leaves it, like the desktop.
							onCloseTask();
							onTab(t);
						}}
					/>
				</View>
				{/* Right-hand spacer keeps the tabs centered against the status dot. */}
				<View style={styles.previewHit} />
			</View>

			{/* The board still works on a skewed box, so this states the risk and offers
			    the one fix, rather than blocking the way the handshake used to. A box
			    AHEAD of the app can't be fixed from here: updating it would only take it
			    further away, so that case just explains itself. */}
			{skew !== null && (
				<View style={styles.skewBar}>
					<Text style={styles.skewText}>
						{skew < PROTOCOL_VERSION
							? boxAtLatest
								? `This box is on the latest Ateam release (v${skew}). This app is ahead of it; the next release clears this.`
								: `This box runs an older Ateam (v${skew}). It works, but newer features will misbehave.`
							: `This box runs a newer Ateam (v${skew}). Update this app from TestFlight.`}
					</Text>
					{skew < PROTOCOL_VERSION && !boxAtLatest && (
						<Pressable
							style={[styles.skewBtn, updating && styles.skewBtnBusy]}
							onPress={onUpdateBox}
							disabled={updating}
						>
							<Text style={styles.skewBtnText}>{updating ? "Updating…" : "Update box"}</Text>
						</Pressable>
					)}
					<Pressable onPress={onDismissSkew} hitSlop={10} accessibilityLabel="Dismiss">
						<Feather name="x" size={16} color={C.amber} />
					</Pressable>
				</View>
			)}
			{skew !== null && updateError && (
				<View style={styles.skewErrorBar}>
					<Text style={styles.skewErrorText}>{updateError}</Text>
				</View>
			)}

			{openTask ? (
				<Term
					key={connGen}
					api={api}
					task={openTask}
					onClose={onCloseTask}
					autoFocus={openTaskFocus}
				/>
			) : null}
			{!openTask && tab === "board" && (
				<ScrollView
					style={styles.board}
					contentContainerStyle={styles.boardContent}
					showsVerticalScrollIndicator={false}
					keyboardShouldPersistTaps="handled"
				>
					<View style={styles.contentColumn}>
						{loading && shown.length === 0 ? (
							<View style={styles.centerPad}>
								<ActivityIndicator color={C.ink} />
								<Text style={styles.footnote}>loading board…</Text>
							</View>
						) : shown.length === 0 ? (
							<View style={styles.centerPad}>
								<Text style={styles.footnote}>no tasks yet — start one below</Text>
							</View>
						) : (
							COLUMNS.map((col) => {
								const inCol = shown.filter((t) => t.column === col.key);
								if (inCol.length === 0) return null;
								return (
									<View key={col.key} style={styles.zone}>
										<View style={styles.eyebrowRow}>
											<View style={[styles.tick, { backgroundColor: col.tint }]} />
											<Text style={styles.eyebrow}>{col.label}</Text>
											<Text style={styles.eyebrowCount}>{inCol.length}</Text>
										</View>
										{inCol.map((t) => (
											<TaskCard key={t.id} task={t} tint={col.tint} onOpen={() => onOpenTask(t)} />
										))}
									</View>
								);
							})
						)}
					</View>
				</ScrollView>
			)}
			{!openTask && tab === "home" && (
				<HomeScreen
					projects={projects}
					selectedProjectId={selectedProjectId}
					onSelectProject={onSelectProject}
					onAddProject={onAddProject}
					tasks={shown}
					loops={loops}
					loading={loading}
					onOpenTask={onOpenTask}
					onOpenLoops={() => onTab("loops")}
					onNewLoop={onNewLoop}
				/>
			)}
			{!openTask && tab === "mission" && (
				<MissionScreen api={api} tasks={missionTasks} onExpand={onExpandTask} />
			)}
			{!openTask && tab === "loops" && (
				<LoopsScreen
					api={api}
					loops={loops}
					tasks={shown}
					onOpenTask={onOpenTask}
					onCreate={onNewLoop}
					onEdit={onEditLoop}
					onChanged={onLoopsChanged}
				/>
			)}

			{!openTask && (tab === "board" || tab === "home") && (
				<Composer agents={agents} busy={creating} onSubmit={onCreate} />
			)}
		</KeyboardAvoidingView>
	);
}

export default function App() {
	useColorScheme(); // reserved: theme-aware later
	const [view, setView] = useState<"connect" | "board">("connect");
	// Which of Home / Board / Mission Control / Loops is showing. Every connect
	// lands on Home, the sidebar-as-a-list.
	const [tab, setTab] = useState<Tab>("home");
	const [loops, setLoops] = useState<LoopDTO[]>([]);
	// The loop form modal: null closed, `editing` null for a new loop.
	const [loopForm, setLoopForm] = useState<{ editing: LoopDTO | null } | null>(null);
	const [host, setHost] = useState("");
	const [port, setPort] = useState("8787");
	const [connecting, setConnecting] = useState(false);
	const [connected, setConnected] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The box's protocol when it differs from ours (null when level). Set on every
	// connect, so a reconnect after an update is what clears the banner.
	const [skew, setSkew] = useState<number | null>(null);
	const [updatingBox, setUpdatingBox] = useState(false);
	// Why the last update attempt failed. Separate from `error` (the connect
	// screen's own state) because this renders on the BOARD, where the button
	// lives — reusing `error` left a failed update with nowhere to show up: the
	// button just flashed and reverted, which is exactly what an
	// Unknown-method rejection looked like the one time this actually happened.
	const [updateError, setUpdateError] = useState<string | null>(null);
	// The skew an update started from. If the reconnect lands on the same version,
	// the box already had the newest release: say so instead of offering it again.
	const updateFrom = useRef<number | null>(null);
	const [boxAtLatest, setBoxAtLatest] = useState(false);
	const [tasks, setTasks] = useState<TaskDTO[]>([]);
	const [projects, setProjects] = useState<ProjectDTO[]>([]);
	const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
	const [agents, setAgents] = useState<AgentDTO[]>([]);
	const [loading, setLoading] = useState(false);
	const [creating, setCreating] = useState(false);
	const [openTask, setOpenTask] = useState<TaskDTO | null>(null);
	const [openTaskFocus, setOpenTaskFocus] = useState(false);
	// The box version whose banner was dismissed; the banner comes back when the
	// box reports a different one. Persisted per box.
	const [dismissedSkew, setDismissedSkew] = useState<number | null>(null);
	const [browserOpen, setBrowserOpen] = useState(false);
	const [previewOpen, setPreviewOpen] = useState(false);
	const [previewPort, setPreviewPort] = useState("3000");
	const conn = useRef<Connection | null>(null);

	// Auto-reattach bookkeeping. `target` is the box we intend to stay connected to
	// (set on connect, cleared on explicit Disconnect) — the trigger for reconnecting.
	// `connGen` bumps on every successful (re)connect: it keys the open terminal so it
	// remounts onto the fresh `api` and cleanly re-resolves its still-alive PTY session.
	const target = useRef<{ host: string; port: string } | null>(null);
	const [connGen, setConnGen] = useState(0);
	const reconnectRef = useRef<() => void>(() => {});
	const attempting = useRef(false);
	const backoff = useRef(0);
	const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// The project to restore on launch (loaded from storage before the first connect,
	// so refresh() prefers it over project #1). Updated on every explicit pick.
	const preferredProjectId = useRef<string | null>(null);

	const refresh = useCallback(async () => {
		const api = conn.current?.api;
		if (!api) return;
		setLoading(true);
		try {
			const projs: ProjectDTO[] = await api.projects.list();
			setProjects(projs);
			setSelectedProjectId((cur) => {
				if (cur) return cur; // keep the live selection across refreshes/reconnects
				const pref = preferredProjectId.current;
				if (pref && projs.some((p) => p.id === pref)) return pref; // restore last pick
				return projs[0]?.id ?? null; // fallback: first project (or none)
			});
			const perProject = await Promise.all(projs.map((p) => api.tasks.list(p.id)));
			const all = perProject.flat().sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0));
			setTasks(all);
			// A box that predates loops rejects the call; the sections just stay empty.
			setLoops(await api.loops.list().catch(() => []));
		} finally {
			setLoading(false);
		}
	}, []);

	// Live updates: merge each pushed task in place (replace by id, or prepend if new).
	// Re-subscribes on `connGen` too, so after an auto-reattach the stream binds to the
	// fresh connection's api rather than the dead one's.
	// biome-ignore lint/correctness/useExhaustiveDependencies: connGen re-binds api after reconnect
	useEffect(() => {
		const api = conn.current?.api;
		if (!api || view !== "board") return;
		const off = api.events.onTaskUpdated((t) => {
			setTasks((prev) => {
				const i = prev.findIndex((x) => x.id === t.id);
				if (i === -1) return [t, ...prev];
				const next = prev.slice();
				next[i] = t;
				return next;
			});
		});
		const offLoops = api.loops.onUpdated((next) => setLoops(next));
		return () => {
			off();
			offLoops();
		};
	}, [view, connGen]);

	// The one connect path — used by the Connect button, the launch auto-connect, and
	// the auto-reattach below. Returns whether it connected, so reconnect() can decide
	// to retry. On success it records the `target` (so drops reattach) and bumps
	// `connGen` (so the board + any open terminal rebind to the fresh api).
	// Consent state. A ref (not state) because connectTo reads it synchronously and must
	// not be re-created when it flips, which would retrigger the effects that depend on it.
	const consented = useRef(false);
	const pendingConnect = useRef<{ host: string; port: string } | null>(null);
	const [consentOpen, setConsentOpen] = useState(false);

	const connectTo = useCallback(
		async (h: string, p: string): Promise<boolean> => {
			const port = p || "8787";
			// Nothing leaves the phone until the disclosure has been accepted. Guarding
			// HERE rather than on the Connect button covers every route in: the button,
			// the launch reattach, and the drop-reconnect loop.
			if (!consented.current) {
				pendingConnect.current = { host: h, port };
				setConsentOpen(true);
				return false;
			}
			if (retryTimer.current) {
				clearTimeout(retryTimer.current);
				retryTimer.current = null;
			}
			setConnecting(true);
			setError(null);
			try {
				conn.current?.close();
				const c = await connect(`ws://${h}:${port}`, {
					onClose: () => {
						// This connection dropped on its own (network flip, box restart, NAT
						// reap). If it's still the live one and we still want the box, reattach.
						if (conn.current !== c || !target.current) return;
						c.close(); // stop its keepalive; socket is already gone
						conn.current = null;
						setConnected(false);
						backoff.current = 0;
						reconnectRef.current();
					},
				});
				conn.current = c;
				target.current = { host: h, port };
				backoff.current = 0;
				await saveConnection({ host: h, port });
				setConnected(true);
				const nextSkew = c.skewed ? c.info.protocolVersion : null;
				setSkew(nextSkew);
				if (updateFrom.current !== null) {
					setBoxAtLatest(nextSkew !== null && nextSkew === updateFrom.current);
					updateFrom.current = null;
				} else if (nextSkew === null) {
					setBoxAtLatest(false);
				}
				// Whatever we came back as, we are no longer mid-update. A reconnect is
				// exactly how an update ends, so this is where the spinner stops.
				setUpdatingBox(false);
				setConnGen((g) => g + 1);
				void c.api.agents.list().then(setAgents);
				setView("board");
				setTab("home");
				await refresh();
				return true;
			} catch (err) {
				conn.current = null;
				setConnected(false);
				setError(err instanceof Error ? err.message : String(err));
				return false;
			} finally {
				setConnecting(false);
			}
		},
		[refresh],
	);

	// Ask the box to replace itself with the current release. The reply lands before
	// the engine goes down, then the socket drops and the reconnect loop picks it up
	// on the new dist, so success here looks like a disconnect, not a result.
	const updateBox = useCallback(async () => {
		const c = conn.current;
		if (!c) return;
		setUpdatingBox(true);
		setUpdateError(null);
		updateFrom.current = skew;
		try {
			await c.update();
		} catch (err) {
			// The likely one: a box older than v7 has no system:update at all, and has
			// to be updated once from a Mac before it can ever do this itself.
			setUpdatingBox(false);
			updateFrom.current = null;
			setUpdateError(err instanceof Error ? err.message : String(err));
		}
	}, [skew]);

	// Reattach to the intended box: try once, and on failure schedule a capped
	// exponential backoff retry (1s → 15s) so a still-down box keeps getting picked up.
	const reconnect = useCallback(async () => {
		const t = target.current;
		if (!t || attempting.current) return;
		if (retryTimer.current) {
			clearTimeout(retryTimer.current);
			retryTimer.current = null;
		}
		attempting.current = true;
		let ok = false;
		try {
			ok = await connectTo(t.host, t.port);
		} finally {
			attempting.current = false;
		}
		if (!ok && target.current) {
			const delay = Math.min(15_000, 1_000 * 2 ** backoff.current);
			backoff.current += 1;
			retryTimer.current = setTimeout(() => {
				retryTimer.current = null;
				void reconnect();
			}, delay);
		}
	}, [connectTo]);

	// Break the connectTo ⇄ reconnect cycle: connectTo's onClose calls through this ref.
	useEffect(() => {
		reconnectRef.current = () => void reconnect();
	}, [reconnect]);

	// Reattach when the app returns to the foreground — the #1 case (app-switching). The
	// socket iOS suspended in the background is usually dead with no close event, so probe
	// it and only reconnect if the probe fails (avoids churning a still-live session).
	useEffect(() => {
		const sub = AppState.addEventListener("change", (s) => {
			if (s !== "active" || !target.current || attempting.current) return;
			void (async () => {
				const alive = conn.current ? await conn.current.ping() : false;
				if (!alive) {
					backoff.current = 0;
					void reconnect();
				}
			})();
		});
		return () => sub.remove();
	}, [reconnect]);

	// Cancel any pending retry on unmount.
	useEffect(
		() => () => {
			if (retryTimer.current) clearTimeout(retryTimer.current);
		},
		[],
	);

	const onConnect = useCallback(() => {
		if (!host.trim()) {
			setError("Enter the box's Tailscale IP or hostname.");
			return;
		}
		void connectTo(host.trim(), port.trim());
	}, [host, port, connectTo]);

	// Enter demo mode: a fully offline Connection (canned board + terminal). No box, no
	// reattach, no saved connection — for App Review (guideline 2.1) and first-look onboarding.
	const startDemo = useCallback(async () => {
		target.current = null; // demo never reattaches
		if (retryTimer.current) {
			clearTimeout(retryTimer.current);
			retryTimer.current = null;
		}
		conn.current?.close();
		conn.current = demoConnection();
		setConnected(true);
		setError(null);
		setConnGen((g) => g + 1);
		void conn.current.api.agents.list().then(setAgents);
		setView("board");
		setTab("home");
		await refresh();
	}, [refresh]);

	// Accepting resumes whatever connection was interrupted, so Agree lands you on the
	// board rather than back on a form you already filled in.
	const onAgreeConsent = useCallback(() => {
		consented.current = true;
		setConsentOpen(false);
		void saveConsent();
		const pending = pendingConnect.current;
		pendingConnect.current = null;
		if (pending) void connectTo(pending.host, pending.port);
	}, [connectTo]);

	// Declining is not a dead end: the demo is offline, so it needs no consent at all.
	const onDeclineConsent = useCallback(() => {
		pendingConnect.current = null;
		setConsentOpen(false);
		void startDemo();
	}, [startDemo]);

	// Pick a project and remember it, so the next launch lands on it (not project #1).
	const selectProject = useCallback((id: string) => {
		preferredProjectId.current = id;
		setSelectedProjectId(id);
		void saveSelectedProject(id);
	}, []);

	// Open the box's dev server in the phone browser. The box IP is exactly the host we
	// connected to (already on the tailnet) — no tunnel, no discovery. Remember the port.
	const openPreview = useCallback(() => {
		const h = target.current?.host;
		if (!h) return;
		const p = previewPort.trim() || "3000";
		void savePreviewPort(p);
		setPreviewOpen(false);
		void Linking.openURL(`http://${h}:${p}`);
	}, [previewPort]);

	// On launch: prefill the last box and auto-reconnect to it, so reopening the app
	// lands straight on the live board (no retyping/tapping). On failure it falls back
	// to the connection screen with the error, fields prefilled.
	// biome-ignore lint/correctness/useExhaustiveDependencies: one-shot on mount
	useEffect(() => {
		void (async () => {
			// Load the remembered project BEFORE connecting, so the first refresh() restores
			// it instead of racing to project #1. Preview port is a plain UI default.
			const [saved, savedProject, savedPreviewPort, agreed] = await Promise.all([
				loadConnection(),
				loadSelectedProject(),
				loadPreviewPort(),
				loadConsent(),
			]);
			if (saved?.host) setDismissedSkew(await loadDismissedSkew(saved.host));
			// Read in the same batch as the connection, so the auto-reattach below can't
			// race ahead of it and show the disclosure to someone who already accepted.
			consented.current = agreed;
			preferredProjectId.current = savedProject;
			if (savedPreviewPort) setPreviewPort(savedPreviewPort);
			if (!saved?.host) return;
			setHost(saved.host);
			setPort(saved.port);
			void connectTo(saved.host, saved.port);
		})();
	}, []);

	// Deep links, mainly for driving the app to a screen for App Store screenshots
	// (xcrun simctl openurl ateamgo://demo[/task/<id>|/preview]). `ateamgo://demo`
	// enters the offline demo; a trailing /task/<id> opens that task's terminal.
	useEffect(() => {
		const handle = (url: string | null): void => {
			if (!url?.startsWith("ateamgo://demo")) return;
			void (async () => {
				await startDemo();
				const api = conn.current?.api;
				if (!api) return;
				const taskId = url.match(/\/task\/([^/?#]+)/)?.[1];
				if (taskId) {
					const projs = await api.projects.list();
					const all = (await Promise.all(projs.map((p) => api.tasks.list(p.id)))).flat();
					const t = all.find((x) => x.id === taskId || x.slug === taskId);
					if (t) setOpenTask(t);
				} else if (url.includes("/preview")) {
					setPreviewOpen(true);
				}
			})();
		};
		void Linking.getInitialURL().then(handle);
		const sub = Linking.addEventListener("url", (e) => handle(e.url));
		return () => sub.remove();
	}, [startDemo]);

	const onDisconnect = useCallback(() => {
		target.current = null; // intent: stay disconnected — no auto-reattach
		if (retryTimer.current) {
			clearTimeout(retryTimer.current);
			retryTimer.current = null;
		}
		backoff.current = 0;
		conn.current?.close();
		conn.current = null;
		setConnected(false);
		setTasks([]);
		setProjects([]);
		setSelectedProjectId(null);
		setLoops([]);
		setView("connect");
	}, []);

	// Composer submit: create a task in the selected project, launch the agent,
	// and open its terminal (which attaches to the just-spawned session).
	const onCreate = useCallback(
		async (input: ComposerSubmit) => {
			const api = conn.current?.api;
			if (!api || !selectedProjectId) return;
			setCreating(true);
			try {
				// Agent mode supplies an explicit name; normal mode derives it from the prompt.
				const name = input.name?.trim() || titleFromPrompt(input.prompt) || "task";
				const task = await api.tasks.create({ projectId: selectedProjectId, name });
				await api.pty.spawnAgent({
					taskId: task.id,
					agentId: input.agentId,
					yolo: input.yolo,
					agentMode: input.agentMode,
					prompt: input.prompt || undefined,
				});
				setTasks((prev) => [task, ...prev.filter((t) => t.id !== task.id)]);
				setOpenTask(task);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setCreating(false);
			}
		},
		[selectedProjectId],
	);

	// The project browser is a full-screen view-swap (NOT a nested modal — presenting
	// a modal while the dropdown modal dismisses deadlocks iOS and freezes the app).
	if (browserOpen && conn.current) {
		return (
			<ProjectBrowser
				conn={conn.current}
				onClose={() => setBrowserOpen(false)}
				onRegistered={(project) => {
					setBrowserOpen(false);
					selectProject(project.id);
					void refresh();
				}}
			/>
		);
	}

	if (consentOpen) {
		return <ConsentScreen onAgree={onAgreeConsent} onDemo={onDeclineConsent} />;
	}

	if (view === "connect") {
		return (
			<ConnectionScreen
				host={host}
				port={port}
				setHost={setHost}
				setPort={setPort}
				onConnect={onConnect}
				onBack={() => setView("board")}
				onDisconnect={onDisconnect}
				onDemo={startDemo}
				connecting={connecting}
				connected={connected}
				error={error}
			/>
		);
	}

	return (
		<>
			<Shell
				connColor={connected ? C.green : C.faint}
				projects={projects}
				selectedProjectId={selectedProjectId}
				onSelectProject={selectProject}
				agents={agents}
				tasks={tasks}
				loading={loading}
				creating={creating}
				onOpenConnection={() => setView("connect")}
				onOpenTask={setOpenTask}
				onCreate={onCreate}
				onAddProject={() => setBrowserOpen(true)}
				skew={skew !== null && skew === dismissedSkew ? null : skew}
				updating={updatingBox}
				updateError={updateError}
				boxAtLatest={boxAtLatest}
				onUpdateBox={updateBox}
				api={conn.current?.api ?? demoConnection().api}
				tab={tab}
				onTab={setTab}
				loops={loops.filter((l) => l.projectId === selectedProjectId)}
				onNewLoop={() => setLoopForm({ editing: null })}
				onEditLoop={(l) => setLoopForm({ editing: l })}
				onLoopsChanged={(next) => setLoops(Array.isArray(next) ? next : loops)}
				openTask={conn.current ? openTask : null}
				openTaskFocus={openTaskFocus}
				onCloseTask={() => {
					setOpenTask(null);
					setOpenTaskFocus(false);
				}}
				onExpandTask={(t) => {
					setOpenTaskFocus(true);
					setOpenTask(t);
				}}
				onDismissSkew={() => {
					if (skew === null) return;
					setDismissedSkew(skew);
					void saveDismissedSkew(target.current?.host ?? "", skew);
				}}
				connGen={connGen}
			/>
			{loopForm && conn.current && (
				<LoopForm
					api={conn.current.api}
					agents={agents}
					projectId={selectedProjectId}
					boxProtocol={skew ?? PROTOCOL_VERSION}
					editing={loopForm.editing}
					onClose={() => setLoopForm(null)}
					onSaved={(next) => {
						setLoopForm(null);
						setLoops(Array.isArray(next) ? next : loops);
					}}
				/>
			)}
			<PreviewModal
				visible={previewOpen}
				host={target.current?.host ?? null}
				port={previewPort}
				setPort={setPreviewPort}
				onOpen={openPreview}
				onClose={() => setPreviewOpen(false)}
			/>
		</>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg, paddingTop: 60 },

	// logo mark (icon.svg redrawn) — connection screen only
	logo: {
		width: 32,
		height: 32,
		borderRadius: 9,
		backgroundColor: "#26262e",
		borderWidth: 1,
		borderColor: C.line,
		paddingHorizontal: 6,
		paddingVertical: 6,
		justifyContent: "center",
		gap: 2.5,
	},
	logoTop: { height: 9, borderRadius: 1.5, backgroundColor: C.ink },
	logoBottom: { flexDirection: "row", gap: 2.5 },
	logoSq: { flex: 1, height: 8, borderRadius: 1.5, backgroundColor: "#ffffff" },

	// board header: [status dot] [project dropdown centered] [spacer]
	boardHeader: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 14,
		paddingBottom: 12,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
	},
	statusHit: { width: 44, alignItems: "flex-start", justifyContent: "center" },
	statusDot: { width: 12, height: 12, borderRadius: 6 },
	headerCenter: { flex: 1, alignItems: "center" },
	previewHit: { width: 44, alignItems: "flex-end", justifyContent: "center" },
	projPill: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
		paddingHorizontal: 14,
		paddingVertical: 7,
		borderRadius: 999,
		maxWidth: 240,
	},
	projName: { color: C.ink, fontSize: 14, fontWeight: "700", letterSpacing: -0.2 },

	// project dropdown modal
	modalBackdrop: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.5)",
		paddingTop: 100,
		alignItems: "center",
	},

	// dev-server preview modal
	previewCard: {
		width: 300,
		backgroundColor: C.surface,
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 12,
		padding: 16,
	},
	previewTitle: { color: C.ink, fontSize: 16, fontWeight: "700", letterSpacing: -0.2 },
	previewSub: { color: C.muted, fontSize: 12, lineHeight: 17, marginTop: 6 },
	previewUrlRow: {
		flexDirection: "row",
		alignItems: "center",
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 8,
		paddingHorizontal: 12,
		paddingVertical: 4,
		marginTop: 14,
	},
	previewUrlText: { color: C.muted, fontSize: 13, fontVariant: ["tabular-nums"], flexShrink: 1 },
	previewPortInput: {
		color: C.ink,
		fontSize: 13,
		fontVariant: ["tabular-nums"],
		fontWeight: "700",
		paddingVertical: 8,
		minWidth: 56,
	},
	previewOpenBtn: {
		backgroundColor: C.ink,
		borderRadius: 8,
		paddingVertical: 11,
		alignItems: "center",
		marginTop: 14,
	},
	previewOpenBtnDisabled: { opacity: 0.4 },
	previewOpenText: { color: "#15151a", fontSize: 14, fontWeight: "800" },

	// connection nav
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
	backText: { color: C.ink, fontSize: 15, fontWeight: "600" },
	spacer: { flex: 1 },
	connectBtn: {
		backgroundColor: C.ink,
		paddingHorizontal: 16,
		paddingVertical: 8,
		borderRadius: 8,
		minWidth: 84,
		alignItems: "center",
	},
	connectBtnBusy: { opacity: 0.7 },
	connectBtnText: { color: "#15151a", fontSize: 13, fontWeight: "800" },

	// eyebrow
	eyebrowRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginBottom: 10,
		paddingLeft: 2,
	},
	tick: { width: 3, height: 12, borderRadius: 2 },
	eyebrow: {
		color: C.muted,
		fontSize: 11,
		fontWeight: "600",
		textTransform: "uppercase",
		letterSpacing: 1.1,
	},
	eyebrowCount: { color: C.faint, fontSize: 11, fontWeight: "600", fontVariant: ["tabular-nums"] },

	// connection form
	formContent: { padding: 16, paddingTop: 20, paddingBottom: 40 },
	formCard: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 10 },
	fieldRow: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 14,
		paddingVertical: 6,
		gap: 12,
	},
	fieldDivider: { borderBottomWidth: 1, borderBottomColor: C.line },
	fieldLabel: { color: C.muted, fontSize: 14 },
	fieldInput: {
		color: C.ink,
		fontSize: 14,
		fontVariant: ["tabular-nums"],
		flex: 1,
		textAlign: "right",
		paddingVertical: 8,
	},
	errorBox: {
		backgroundColor: TINT[C.red],
		borderWidth: 1,
		borderColor: "rgba(248,113,113,0.4)",
		borderRadius: 8,
		padding: 12,
		marginTop: 16,
	},
	errorText: { color: C.red, fontSize: 13, lineHeight: 18 },
	disconnectBtn: {
		marginTop: 20,
		borderWidth: 1,
		borderColor: "rgba(248,113,113,0.4)",
		borderRadius: 10,
		paddingVertical: 12,
		alignItems: "center",
	},
	disconnectText: { color: C.red, fontSize: 14, fontWeight: "700" },
	demoRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 20 },
	demoRule: { flex: 1, height: 1, backgroundColor: C.line },
	demoOr: { color: C.faint, fontSize: 12 },
	demoBtn: {
		marginTop: 14,
		borderWidth: 1,
		borderColor: C.line,
		backgroundColor: C.surface,
		borderRadius: 10,
		paddingVertical: 13,
		alignItems: "center",
	},
	demoText: { color: C.ink, fontSize: 14, fontWeight: "700" },
	formNote: { color: C.faint, fontSize: 12, lineHeight: 18, marginTop: 18, paddingHorizontal: 2 },
	mono: { color: C.muted, fontVariant: ["tabular-nums"] },

	// board
	// Warns without alarming: the board underneath still works.
	skewBar: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingHorizontal: 14,
		paddingVertical: 9,
		backgroundColor: "#3a2f12",
		borderBottomWidth: 1,
		borderBottomColor: "#5a4a1c",
	},
	skewText: { flex: 1, color: "#f0d68c", fontSize: 12, lineHeight: 16 },
	skewBtn: {
		paddingHorizontal: 11,
		paddingVertical: 6,
		borderRadius: 6,
		backgroundColor: "#5a4a1c",
	},
	skewBtnBusy: { opacity: 0.55 },
	skewBtnText: { color: "#ffe9ad", fontSize: 12, fontWeight: "600" },
	// A failed update, directly under the row whose button caused it. Red rather
	// than the banner's amber: this is the one case that's a genuine failure, not
	// a known, working-as-intended state.
	skewErrorBar: {
		paddingHorizontal: 14,
		paddingVertical: 8,
		backgroundColor: "#3a1414",
		borderBottomWidth: 1,
		borderBottomColor: "#5a2020",
	},
	skewErrorText: { color: "#f8a8a8", fontSize: 12, lineHeight: 16 },
	board: { flex: 1 },
	boardContent: { padding: 16, paddingBottom: 24 },
	// Centered, width-capped content column (see CONTENT_MAX) — keeps the phone layout
	// from stretching on iPad; a no-op on iPhone.
	contentColumn: { width: "100%", maxWidth: CONTENT_MAX, alignSelf: "center" },
	centerPad: { alignItems: "center", paddingVertical: 48, gap: 12 },
	zone: { marginBottom: 22 },
	card: {
		backgroundColor: C.surface,
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 8,
		padding: 12,
		marginBottom: 8,
	},
	cardTop: { flexDirection: "row", alignItems: "flex-start", gap: 9 },
	agentTag: {
		width: 22,
		height: 22,
		borderRadius: 6,
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
		alignItems: "center",
		justifyContent: "center",
	},
	agentInitial: { color: C.muted, fontSize: 11, fontWeight: "700" },
	cardName: { color: C.ink, fontSize: 15, fontWeight: "600", flex: 1, lineHeight: 20 },
	cardMeta: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10, flexWrap: "wrap" },
	chip: {
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 6,
		paddingHorizontal: 7,
		paddingVertical: 3,
	},
	chipText: { color: C.muted, fontSize: 11, fontVariant: ["tabular-nums"] },
	badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
	badgeText: { fontSize: 11, fontWeight: "600" },
	footnote: { color: C.faint, fontSize: 11, textAlign: "center", marginTop: 8 },
});
