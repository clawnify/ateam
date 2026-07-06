// Ateam mobile — board + connection preview.
// Design: Ateam's own dark/teal identity, applying the clawnify DESIGN-apps
// structural signature (labeled eyebrow zones · chips for facts vs tinted badges
// for signals · monochrome chrome, color reserved for status · engineered numbers
// · borders not shadows · no emoji) — NOT its brand theme (coral / light canvas).
// Connection model = ALWAYS SSH: a host is Label · IP/Hostname · Port · Username ·
// Key (Termius's model); the IP is just what you point at the box's Tailscale
// address. Preview scope: mock data; live SSH wiring (buildAteamApi over a
// native-SSH ClientTransport) is next.
import { useState } from "react";
import { Pressable, ScrollView, StatusBar, StyleSheet, Text, useColorScheme, View } from "react-native";

const C = {
	bg: "#0b0d10",
	surface: "#14171c",
	sunken: "#1a1e25",
	line: "#242b35",
	ink: "#e7ebf1",
	muted: "#8b96a6",
	faint: "#5a6472",
	teal: "#35d1c0",
	amber: "#e6a94b",
	blue: "#6ea8fe",
	green: "#67cd8b",
};

const TINT: Record<string, string> = {
	[C.amber]: "rgba(230,169,75,0.14)",
	[C.teal]: "rgba(53,209,192,0.14)",
	[C.blue]: "rgba(110,168,254,0.14)",
	[C.green]: "rgba(103,205,139,0.14)",
	[C.muted]: "rgba(139,150,166,0.12)",
};

type Column = "needs_attention" | "running" | "review" | "todo" | "merged";
const COLUMNS: { key: Column; label: string; tint: string }[] = [
	{ key: "needs_attention", label: "Needs You", tint: C.amber },
	{ key: "running", label: "In Progress", tint: C.teal },
	{ key: "review", label: "Review", tint: C.blue },
	{ key: "todo", label: "Backlog", tint: C.muted },
	{ key: "merged", label: "Done", tint: C.green },
];

type Task = { name: string; column: Column; agent: string; branch: string; note: string };
const TASKS: Task[] = [
	{ name: "Fix SSH reconnect on wake", column: "needs_attention", agent: "claude", branch: "fix/ssh-reconnect", note: "awaiting your input" },
	{ name: "Tailscale reachability for the daemon", column: "running", agent: "claude", branch: "feat/tailnet-host", note: "editing host.ts" },
	{ name: "Board reconciler perf", column: "running", agent: "codex", branch: "perf/reconciler", note: "running tests" },
	{ name: "Connections screen", column: "review", agent: "claude", branch: "feat/connections-ui", note: "3 files changed" },
	{ name: "Rename daemon → engine", column: "todo", agent: "claude", branch: "chore/rename", note: "queued" },
	{ name: "Remote fs picker", column: "merged", agent: "claude", branch: "feat/fs-listdir", note: "merged · PR #45" },
];

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
			<Text style={styles.agentInitial}>{agent[0]?.toUpperCase()}</Text>
		</View>
	);
}

function TaskCard({ task, tint }: { task: Task; tint: string }) {
	return (
		<View style={styles.card}>
			<View style={styles.cardTop}>
				<AgentTag agent={task.agent} />
				<Text style={styles.cardName} numberOfLines={2}>
					{task.name}
				</Text>
			</View>
			<View style={styles.cardMeta}>
				<Chip>{task.branch}</Chip>
				<Badge tint={tint}>{task.note}</Badge>
			</View>
		</View>
	);
}

// ── Connection screen — one SSH target, Termius-modeled (no transport toggle) ──

function FieldRow({
	label,
	value,
	keyChip,
	last,
}: {
	label: string;
	value: string;
	keyChip?: boolean;
	last?: boolean;
}) {
	return (
		<View style={[styles.fieldRow, !last && styles.fieldDivider]}>
			<Text style={styles.fieldLabel}>{label}</Text>
			{keyChip ? (
				<View style={styles.keyChip}>
					<Text style={styles.keyChipText}>{value}</Text>
				</View>
			) : (
				<Text style={styles.fieldValue}>{value}</Text>
			)}
		</View>
	);
}

function ConnectionScreen({ onConnect }: { onConnect: () => void }) {
	return (
		<View style={styles.root}>
			<StatusBar barStyle="light-content" backgroundColor={C.bg} />
			<View style={styles.navBar}>
				<View style={styles.monogram}>
					<Text style={styles.monogramText}>A</Text>
				</View>
				<Text style={styles.navTitle}>New connection</Text>
				<View style={styles.spacer} />
				<Pressable style={styles.connectBtn} onPress={onConnect} hitSlop={6}>
					<Text style={styles.connectBtnText}>Connect</Text>
				</Pressable>
			</View>

			<ScrollView contentContainerStyle={styles.formContent} showsVerticalScrollIndicator={false}>
				<View style={styles.eyebrowRow}>
					<View style={[styles.tick, { backgroundColor: C.teal }]} />
					<Text style={styles.eyebrow}>Host</Text>
				</View>
				<View style={styles.formCard}>
					<FieldRow label="Label" value="hetzner-devbox" />
					<FieldRow label="IP or Hostname" value="100.72.63.61" />
					<FieldRow label="Port" value="22" last />
				</View>

				<View style={[styles.eyebrowRow, { marginTop: 22 }]}>
					<View style={[styles.tick, { backgroundColor: C.teal }]} />
					<Text style={styles.eyebrow}>Credentials</Text>
				</View>
				<View style={styles.formCard}>
					<FieldRow label="Username" value="pallaoro" />
					<FieldRow label="SSH Key" value="ED25519" keyChip last />
				</View>

				<Text style={styles.formNote}>
					Always SSH. The IP is the box's Tailscale address — same user, same key. Tailscale just
					changes the address you connect to.
				</Text>
			</ScrollView>
		</View>
	);
}

// ── Board screen ──

function BoardScreen({ onOpenConnection }: { onOpenConnection: () => void }) {
	return (
		<View style={styles.root}>
			<StatusBar barStyle="light-content" backgroundColor={C.bg} />
			<View style={styles.header}>
				<View style={styles.brandRow}>
					<View style={styles.monogram}>
						<Text style={styles.monogramText}>A</Text>
					</View>
					<Text style={styles.brand}>Ateam</Text>
					<View style={styles.spacer} />
					<Pressable style={styles.connPill} onPress={onOpenConnection} hitSlop={6}>
						<View style={styles.connDot} />
						<Text style={styles.connText}>hetzner-devbox</Text>
					</Pressable>
				</View>
				<Text style={styles.connMeta}>
					SSH · <Text style={styles.connHost}>pallaoro@100.72.63.61</Text> · claude
				</Text>
			</View>

			<ScrollView style={styles.board} contentContainerStyle={styles.boardContent} showsVerticalScrollIndicator={false}>
				{COLUMNS.map((col) => {
					const tasks = TASKS.filter((t) => t.column === col.key);
					if (tasks.length === 0) return null;
					return (
						<View key={col.key} style={styles.zone}>
							<View style={styles.eyebrowRow}>
								<View style={[styles.tick, { backgroundColor: col.tint }]} />
								<Text style={styles.eyebrow}>{col.label}</Text>
								<Text style={styles.eyebrowCount}>{tasks.length}</Text>
							</View>
							{tasks.map((t) => (
								<TaskCard key={t.name} task={t} tint={col.tint} />
							))}
						</View>
					);
				})}
				<Text style={styles.footnote}>preview · mock board · live SSH wiring next</Text>
			</ScrollView>
		</View>
	);
}

export default function App() {
	useColorScheme(); // reserved: theme-aware later
	// Board is home; tapping the connection pill opens the SSH host form.
	const [view, setView] = useState<"connect" | "board">("board");
	return view === "connect" ? (
		<ConnectionScreen onConnect={() => setView("board")} />
	) : (
		<BoardScreen onOpenConnection={() => setView("connect")} />
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg, paddingTop: 60 },

	// header / nav
	header: { paddingHorizontal: 18, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: C.line },
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
	monogram: {
		width: 30,
		height: 30,
		borderRadius: 8,
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
		alignItems: "center",
		justifyContent: "center",
	},
	monogramText: { color: C.teal, fontSize: 16, fontWeight: "800" },
	brand: { color: C.ink, fontSize: 20, fontWeight: "700", letterSpacing: -0.3 },
	spacer: { flex: 1 },
	connectBtn: { backgroundColor: C.teal, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
	connectBtnText: { color: "#04211d", fontSize: 13, fontWeight: "800" },
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
	},
	connDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.green },
	connText: { color: C.muted, fontSize: 12, fontWeight: "600" },
	connMeta: { color: C.muted, fontSize: 12, marginTop: 12 },
	connHost: { color: C.ink, fontVariant: ["tabular-nums"] },

	// eyebrow
	eyebrowRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10, paddingLeft: 2 },
	tick: { width: 3, height: 12, borderRadius: 2 },
	eyebrow: { color: C.muted, fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1.1 },
	eyebrowCount: { color: C.faint, fontSize: 11, fontWeight: "600", fontVariant: ["tabular-nums"] },

	// connection form
	formContent: { padding: 16, paddingTop: 20, paddingBottom: 40 },
	formCard: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 10 },
	fieldRow: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 14,
		paddingVertical: 14,
		gap: 12,
	},
	fieldDivider: { borderBottomWidth: 1, borderBottomColor: C.line },
	fieldLabel: { color: C.muted, fontSize: 14 },
	fieldValue: { color: C.ink, fontSize: 14, fontVariant: ["tabular-nums"], flexShrink: 1, textAlign: "right" },
	keyChip: { backgroundColor: C.sunken, borderWidth: 1, borderColor: C.line, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
	keyChipText: { color: C.teal, fontSize: 12, fontWeight: "600", letterSpacing: 0.3 },
	formNote: { color: C.faint, fontSize: 12, lineHeight: 18, marginTop: 18, paddingHorizontal: 2 },

	// board
	board: { flex: 1 },
	boardContent: { padding: 16, paddingBottom: 40 },
	zone: { marginBottom: 22 },
	card: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 12, marginBottom: 8 },
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
	chip: { backgroundColor: C.sunken, borderWidth: 1, borderColor: C.line, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
	chipText: { color: C.muted, fontSize: 11, fontVariant: ["tabular-nums"] },
	badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
	badgeText: { fontSize: 11, fontWeight: "600" },
	footnote: { color: C.faint, fontSize: 11, textAlign: "center", marginTop: 8 },
});
