// Ateam mobile — a thin remote for a box running the Ateam engine. The phone
// opens a WebSocket to the box's opt-in `ateam` WS listener (over Tailscale),
// handshakes, and drives the SAME engine the desktop does via the shared
// @ateam/protocol contract (see src/connection.ts). The board below is LIVE:
// projects/tasks come from the engine and taskUpdated pushes keep it fresh.
//
// Theme = Ateam's real tokens (apps/desktop/src/renderer/src/index.css): near-black
// #0c0c0e canvas, purple accent #7c5cff, ink/white primary action (a hue is never
// the CTA), amber/blue/green status. Logo = the "mission-control tiling" mark from
// apps/desktop/build/icon.svg, redrawn with Views. Connection = ALWAYS a WebSocket
// to a Tailscale address (RN can't spawn ssh; WireGuard is the auth boundary).

import type { ProjectDTO, TaskDTO } from "@ateam/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	Pressable,
	ScrollView,
	StatusBar,
	StyleSheet,
	Text,
	TextInput,
	useColorScheme,
	View,
} from "react-native";
import { type Connection, connect } from "./src/connection";

const C = {
	bg: "#0c0c0e",
	surface: "#141418", // --bg-elev
	sunken: "#1c1c22", // --bg-elev-2
	line: "#2a2a33", // --border
	ink: "#e6e6ea", // --text
	muted: "#9a9aa6", // --text-dim
	faint: "#6a6a75",
	accent: "#7c5cff", // --accent (Ateam purple)
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

// Column keys match @ateam/protocol's KanbanColumn exactly, so a live TaskDTO's
// `column` drops straight into the right zone.
const COLUMNS: { key: TaskDTO["column"]; label: string; tint: string }[] = [
	{ key: "needs_attention", label: "Needs You", tint: C.amber },
	{ key: "running", label: "In Progress", tint: C.accent },
	{ key: "review", label: "Review", tint: C.blue },
	{ key: "todo", label: "Backlog", tint: C.muted },
	{ key: "merged", label: "Done", tint: C.green },
];

// A short status line for a card, derived from the live task (mirrors the desktop's
// signal priority: a pending question first, then agent state, then git/PR facts).
function taskNote(t: TaskDTO): string {
	if (t.column === "needs_attention") return "awaiting your input";
	if (t.agentStatus === "running") return "running";
	if (t.mergeStatus) return t.mergeStatus;
	if (t.prNumber != null) return `PR #${t.prNumber}`;
	const dirty = t.gitStatus?.dirty ?? 0;
	if (dirty > 0) return `${dirty} changed`;
	return t.agentStatus ?? "idle";
}

// The Ateam logo mark: a wide top pane + two dimming squares (icon.svg), on a dark
// tile. Redrawn with Views so it scales + themes with no native SVG dependency.
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

function TaskCard({ task, tint }: { task: TaskDTO; tint: string }) {
	return (
		<View style={styles.card}>
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
		</View>
	);
}

// ── Connection screen — one WebSocket target (host = the box's Tailscale IP) ──

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
	connecting,
	error,
}: {
	host: string;
	port: string;
	setHost: (t: string) => void;
	setPort: (t: string) => void;
	onConnect: () => void;
	connecting: boolean;
	error: string | null;
}) {
	return (
		<View style={styles.root}>
			<StatusBar barStyle="light-content" backgroundColor={C.bg} />
			<View style={styles.navBar}>
				<LogoMark />
				<Text style={styles.navTitle}>New connection</Text>
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
						<Text style={styles.connectBtnText}>Connect</Text>
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

				<Text style={styles.formNote}>
					The phone opens a WebSocket to your box's `ateam` listener over Tailscale — WireGuard is
					the encryption and the auth boundary. Enable it on the box with{" "}
					<Text style={styles.mono}>ATEAM_WS_ADDR=&lt;tailscale-ip&gt;:&lt;port&gt;</Text> (never a
					wildcard bind).
				</Text>
			</ScrollView>
		</View>
	);
}

// ── Board screen — LIVE tasks from the connected engine ──

function BoardScreen({
	host,
	agents,
	tasks,
	loading,
	onOpenConnection,
	onRefresh,
}: {
	host: string;
	agents: string[];
	tasks: TaskDTO[];
	loading: boolean;
	onOpenConnection: () => void;
	onRefresh: () => void;
}) {
	return (
		<View style={styles.root}>
			<StatusBar barStyle="light-content" backgroundColor={C.bg} />
			<View style={styles.header}>
				<View style={styles.brandRow}>
					<LogoMark />
					<Text style={styles.brand}>Ateam</Text>
					<View style={styles.spacer} />
					<Pressable style={styles.connPill} onPress={onOpenConnection} hitSlop={6}>
						<View style={styles.connDot} />
						<Text style={styles.connText} numberOfLines={1}>
							{host}
						</Text>
					</Pressable>
				</View>
				<Text style={styles.connMeta}>
					WS · <Text style={styles.connHost}>{host}</Text> ·{" "}
					{agents.length ? agents.join(", ") : "no agents"}
				</Text>
			</View>

			<ScrollView
				style={styles.board}
				contentContainerStyle={styles.boardContent}
				showsVerticalScrollIndicator={false}
			>
				{loading && tasks.length === 0 ? (
					<View style={styles.centerPad}>
						<ActivityIndicator color={C.accent} />
						<Text style={styles.footnote}>loading board…</Text>
					</View>
				) : tasks.length === 0 ? (
					<View style={styles.centerPad}>
						<Text style={styles.footnote}>no tasks on this box yet</Text>
					</View>
				) : (
					COLUMNS.map((col) => {
						const inCol = tasks.filter((t) => t.column === col.key);
						if (inCol.length === 0) return null;
						return (
							<View key={col.key} style={styles.zone}>
								<View style={styles.eyebrowRow}>
									<View style={[styles.tick, { backgroundColor: col.tint }]} />
									<Text style={styles.eyebrow}>{col.label}</Text>
									<Text style={styles.eyebrowCount}>{inCol.length}</Text>
								</View>
								{inCol.map((t) => (
									<TaskCard key={t.id} task={t} tint={col.tint} />
								))}
							</View>
						);
					})
				)}
				<Pressable onPress={onRefresh} hitSlop={8}>
					<Text style={styles.footnote}>tap to refresh</Text>
				</Pressable>
			</ScrollView>
		</View>
	);
}

export default function App() {
	useColorScheme(); // reserved: theme-aware later
	const [view, setView] = useState<"connect" | "board">("connect");
	const [host, setHost] = useState("");
	const [port, setPort] = useState("8787");
	const [connecting, setConnecting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [tasks, setTasks] = useState<TaskDTO[]>([]);
	const [agents, setAgents] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
	const conn = useRef<Connection | null>(null);

	// Pull the whole board: every project's tasks, flattened. Sorted newest-active
	// first so the freshest work leads each column.
	const refresh = useCallback(async () => {
		const api = conn.current?.api;
		if (!api) return;
		setLoading(true);
		try {
			const projects: ProjectDTO[] = await api.projects.list();
			const perProject = await Promise.all(projects.map((p) => api.tasks.list(p.id)));
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
			setAgents(c.info.agents);
			setView("board");
			await refresh();
		} catch (err) {
			conn.current = null;
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setConnecting(false);
		}
	}, [host, port, refresh]);

	return view === "connect" ? (
		<ConnectionScreen
			host={host}
			port={port}
			setHost={setHost}
			setPort={setPort}
			onConnect={onConnect}
			connecting={connecting}
			error={error}
		/>
	) : (
		<BoardScreen
			host={host}
			agents={agents}
			tasks={tasks}
			loading={loading}
			onOpenConnection={() => setView("connect")}
			onRefresh={refresh}
		/>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg, paddingTop: 60 },

	// logo mark (icon.svg redrawn)
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

	// header / nav
	header: {
		paddingHorizontal: 18,
		paddingBottom: 14,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
	},
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
	brandRow: { flexDirection: "row", alignItems: "center", gap: 10 },
	brand: { color: C.ink, fontSize: 20, fontWeight: "700", letterSpacing: -0.3 },
	spacer: { flex: 1 },
	// Primary action = ink/white (a hue is never the CTA — Ateam + clawnify).
	connectBtn: {
		backgroundColor: C.ink,
		paddingHorizontal: 16,
		paddingVertical: 8,
		borderRadius: 8,
		minWidth: 74,
		alignItems: "center",
	},
	connectBtnBusy: { opacity: 0.7 },
	connectBtnText: { color: "#15151a", fontSize: 13, fontWeight: "800" },
	connPill: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
		paddingHorizontal: 10,
		paddingVertical: 5,
		borderRadius: 999,
		maxWidth: 180,
	},
	connDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.green },
	connText: { color: C.muted, fontSize: 12, fontWeight: "600" },
	connMeta: { color: C.muted, fontSize: 12, marginTop: 12 },
	connHost: { color: C.ink, fontVariant: ["tabular-nums"] },

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
	formNote: { color: C.faint, fontSize: 12, lineHeight: 18, marginTop: 18, paddingHorizontal: 2 },
	mono: { color: C.muted, fontVariant: ["tabular-nums"] },

	// board
	board: { flex: 1 },
	boardContent: { padding: 16, paddingBottom: 40 },
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
