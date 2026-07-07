// Ateam mobile — a thin remote for a box running the Ateam engine. The phone
// opens a WebSocket to the box's opt-in `ateam` WS listener (over Tailscale),
// handshakes, and drives the SAME engine the desktop does via the shared
// @ateam/protocol contract (see src/connection.ts). The board is LIVE and the
// composer creates + launches tasks on the box; tapping a task opens its terminal.
//
// Theme = Ateam's real tokens (apps/desktop/src/renderer/src/index.css): near-black
// #0c0c0e canvas, purple accent #7c5cff, ink/white primary action, amber/blue/green
// status. Connection = ALWAYS a WebSocket to a Tailscale address (RN can't spawn
// ssh; WireGuard is the auth boundary).
import type { AgentDTO, ProjectDTO, TaskDTO } from "@ateam/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	KeyboardAvoidingView,
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
import { Composer, type ComposerSubmit } from "./src/Composer";
import { type Connection, connect } from "./src/connection";
import { loadConnection, saveConnection } from "./src/storage";
import { TerminalScreen } from "./src/TerminalScreen";

const C = {
	bg: "#0c0c0e",
	surface: "#141418",
	sunken: "#1c1c22",
	line: "#2a2a33",
	ink: "#e6e6ea",
	muted: "#9a9aa6",
	faint: "#6a6a75",
	accent: "#7c5cff",
	green: "#4ade80",
	amber: "#fbbf24",
	red: "#f87171",
	blue: "#60a5fa",
};

const TINT: Record<string, string> = {
	[C.amber]: "rgba(251,191,36,0.13)",
	[C.accent]: "rgba(124,92,255,0.16)",
	[C.blue]: "rgba(96,165,250,0.14)",
	[C.green]: "rgba(74,222,128,0.13)",
	[C.muted]: "rgba(154,154,166,0.12)",
	[C.red]: "rgba(248,113,113,0.14)",
};

const COLUMNS: { key: TaskDTO["column"]; label: string; tint: string }[] = [
	{ key: "needs_attention", label: "Needs You", tint: C.amber },
	{ key: "running", label: "In Progress", tint: C.accent },
	{ key: "review", label: "Review", tint: C.blue },
	{ key: "todo", label: "Backlog", tint: C.muted },
	{ key: "merged", label: "Done", tint: C.green },
];

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
	return (
		<View style={styles.agentTag}>
			<Text style={styles.agentInitial}>{agent[0]?.toUpperCase() ?? "·"}</Text>
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

// ── Project dropdown — centered in the board header ──

function ProjectDropdown({
	projects,
	selectedId,
	onSelect,
}: {
	projects: ProjectDTO[];
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const selected = projects.find((p) => p.id === selectedId);
	return (
		<>
			<Pressable style={styles.projPill} onPress={() => setOpen(true)} hitSlop={6}>
				<Text style={styles.projName} numberOfLines={1}>
					{selected?.name ?? "No project"}
				</Text>
				<Text style={styles.projCaret}>▾</Text>
			</Pressable>
			<Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
				<Pressable style={styles.modalBackdrop} onPress={() => setOpen(false)}>
					<View style={styles.modalCard}>
						{projects.length === 0 ? (
							<Text style={styles.modalEmpty}>No projects on this box</Text>
						) : (
							projects.map((p) => (
								<Pressable
									key={p.id}
									style={styles.modalRow}
									onPress={() => {
										onSelect(p.id);
										setOpen(false);
									}}
								>
									<View
										style={[
											styles.modalDot,
											{ backgroundColor: p.id === selectedId ? C.accent : "transparent" },
										]}
									/>
									<Text style={styles.modalRowText} numberOfLines={1}>
										{p.name}
									</Text>
								</Pressable>
							))
						)}
					</View>
				</Pressable>
			</Modal>
		</>
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
				<View style={styles.eyebrowRow}>
					<View style={[styles.tick, { backgroundColor: C.accent }]} />
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
			</ScrollView>
		</View>
	);
}

// ── Board screen — status dot (left) · project dropdown (center) · composer ──

function BoardScreen({
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
}) {
	const shown = tasks.filter((t) => t.projectId === selectedProjectId);
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
					<ProjectDropdown
						projects={projects}
						selectedId={selectedProjectId}
						onSelect={onSelectProject}
					/>
				</View>
				<View style={styles.statusHit} />
			</View>

			<ScrollView
				style={styles.board}
				contentContainerStyle={styles.boardContent}
				showsVerticalScrollIndicator={false}
				keyboardShouldPersistTaps="handled"
			>
				{loading && shown.length === 0 ? (
					<View style={styles.centerPad}>
						<ActivityIndicator color={C.accent} />
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
			</ScrollView>

			<Composer agents={agents} busy={creating} onSubmit={onCreate} />
		</KeyboardAvoidingView>
	);
}

export default function App() {
	useColorScheme(); // reserved: theme-aware later
	const [view, setView] = useState<"connect" | "board">("connect");
	const [host, setHost] = useState("");
	const [port, setPort] = useState("8787");
	const [connecting, setConnecting] = useState(false);
	const [connected, setConnected] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [tasks, setTasks] = useState<TaskDTO[]>([]);
	const [projects, setProjects] = useState<ProjectDTO[]>([]);
	const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
	const [agents, setAgents] = useState<AgentDTO[]>([]);
	const [loading, setLoading] = useState(false);
	const [creating, setCreating] = useState(false);
	const [openTask, setOpenTask] = useState<TaskDTO | null>(null);
	const conn = useRef<Connection | null>(null);

	// Prefill the last box on launch, so a restart/reinstall doesn't lose the IP.
	useEffect(() => {
		void loadConnection().then((saved) => {
			if (saved) {
				setHost(saved.host);
				setPort(saved.port);
			}
		});
	}, []);

	const refresh = useCallback(async () => {
		const api = conn.current?.api;
		if (!api) return;
		setLoading(true);
		try {
			const projs: ProjectDTO[] = await api.projects.list();
			setProjects(projs);
			setSelectedProjectId((cur) => cur ?? projs[0]?.id ?? null);
			const perProject = await Promise.all(projs.map((p) => api.tasks.list(p.id)));
			const all = perProject.flat().sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0));
			setTasks(all);
		} finally {
			setLoading(false);
		}
	}, []);

	// Live updates: merge each pushed task in place (replace by id, or prepend if new).
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
		return off;
	}, [view]);

	const onConnect = useCallback(async () => {
		if (!host.trim()) {
			setError("Enter the box's Tailscale IP or hostname.");
			return;
		}
		setConnecting(true);
		setError(null);
		try {
			conn.current?.close();
			const c = await connect(`ws://${host.trim()}:${port.trim() || "8787"}`);
			conn.current = c;
			await saveConnection({ host: host.trim(), port: port.trim() || "8787" });
			setConnected(true);
			void c.api.agents.list().then(setAgents);
			setView("board");
			await refresh();
		} catch (err) {
			conn.current = null;
			setConnected(false);
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setConnecting(false);
		}
	}, [host, port, refresh]);

	const onDisconnect = useCallback(() => {
		conn.current?.close();
		conn.current = null;
		setConnected(false);
		setTasks([]);
		setProjects([]);
		setSelectedProjectId(null);
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
				const name = titleFromPrompt(input.prompt) || (input.agentMode ? "agent session" : "task");
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

	// A tapped task opens its live terminal (api comes from the live connection).
	if (openTask && conn.current) {
		return (
			<TerminalScreen api={conn.current.api} task={openTask} onClose={() => setOpenTask(null)} />
		);
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
				connecting={connecting}
				connected={connected}
				error={error}
			/>
		);
	}

	return (
		<BoardScreen
			connColor={connected ? C.green : C.faint}
			projects={projects}
			selectedProjectId={selectedProjectId}
			onSelectProject={setSelectedProjectId}
			agents={agents}
			tasks={tasks}
			loading={loading}
			creating={creating}
			onOpenConnection={() => setView("connect")}
			onOpenTask={setOpenTask}
			onCreate={onCreate}
		/>
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
	projCaret: { color: C.muted, fontSize: 11 },

	// project dropdown modal
	modalBackdrop: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.5)",
		paddingTop: 100,
		alignItems: "center",
	},
	modalCard: {
		width: 280,
		backgroundColor: C.surface,
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 12,
		paddingVertical: 6,
	},
	modalEmpty: { color: C.muted, fontSize: 13, textAlign: "center", paddingVertical: 16 },
	modalRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingHorizontal: 14,
		paddingVertical: 12,
	},
	modalDot: { width: 7, height: 7, borderRadius: 4 },
	modalRowText: { color: C.ink, fontSize: 15, flex: 1 },

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
	backText: { color: C.accent, fontSize: 15, fontWeight: "600" },
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
	formNote: { color: C.faint, fontSize: 12, lineHeight: 18, marginTop: 18, paddingHorizontal: 2 },
	mono: { color: C.muted, fontVariant: ["tabular-nums"] },

	// board
	board: { flex: 1 },
	boardContent: { padding: 16, paddingBottom: 24 },
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
