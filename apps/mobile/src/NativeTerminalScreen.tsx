// SPIKE: a terminal backed by the native SwiftTerm view instead of xterm-in-webview.
// Same PTY contract (attach-if-live / spawn, snapshot+seq, onData→feed, input→write,
// size→resize) — only the renderer changes. SwiftTerm is a native UIScrollView, so
// scroll / selection / copy are native (the whole reason for the swap). Kept
// separate from TerminalScreen so the webview path stays intact while we evaluate.

import type { AteamApi, PtyDataEvent, TaskDTO } from "@ateam/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	KeyboardAvoidingView,
	Platform,
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

const C = {
	bg: "#0c0c0e",
	surface: "#141418",
	sunken: "#1c1c22",
	line: "#2a2a33",
	ink: "#e6e6ea",
	muted: "#9a9aa6",
	red: "#f87171",
	green: "#4ade80",
};

// TUI control bytes the soft keyboard can't send (our own bar — SwiftTerm's is off).
// PgUp/PgDn drive the TUI's OWN scroll (Claude Code scrolls its conversation on
// PageUp/PageDown in every mode) — the reliable way to scroll a full-screen agent,
// vs the emulator scrollback (empty on an alt-screen).
const KEYS: { label: string; bytes: string; scroll?: boolean }[] = [
	{ label: "esc", bytes: "\x1b" },
	{ label: "⇧tab", bytes: "\x1b[Z" },
	{ label: "PgUp", bytes: "\x1b[5~", scroll: true },
	{ label: "PgDn", bytes: "\x1b[6~", scroll: true },
	{ label: "/", bytes: "/" },
	{ label: "←", bytes: "\x1b[D" },
	{ label: "↑", bytes: "\x1b[A" },
	{ label: "↓", bytes: "\x1b[B" },
	{ label: "→", bytes: "\x1b[C" },
	{ label: "^C", bytes: "\x03" },
];

export function NativeTerminalScreen({
	api,
	task,
	onClose,
}: {
	api: AteamApi;
	task: TaskDTO;
	onClose: () => void;
}) {
	const termRef = useRef<SwiftTermHandle>(null);
	const [terminalId, setTerminalId] = useState<string | null>(null);
	const [status, setStatus] = useState<"connecting" | "live" | "error">("connecting");
	const [detail, setDetail] = useState("resolving session…");

	const buffered = useRef<PtyDataEvent[]>([]);
	const applied = useRef(false);
	const lastSeq = useRef(-1);
	const snapped = useRef(false);

	const feed = useCallback((data: string) => termRef.current?.feed(data), []);

	// Resolve the PTY (attach-if-live, else spawn) and subscribe to its stream.
	useEffect(() => {
		let cancelled = false;
		let offData = () => {};
		let offExit = () => {};
		// The RPC client has no per-call timeout, so a half-open WS (common on mobile
		// over Tailscale) makes a call hang forever with no error. Cap the fast resolve
		// calls so a stall surfaces as an actionable error instead of "resolving…" limbo.
		const withTimeout = <T,>(p: Promise<T>, what: string): Promise<T> =>
			Promise.race([
				p,
				new Promise<T>((_, rej) =>
					setTimeout(
						() => rej(new Error(`${what} timed out (connection may have dropped)`)),
						12000,
					),
				),
			]);

		(async () => {
			try {
				const live = await withTimeout(api.pty.listForTask(task.id), "listForTask");
				let id = live[0]?.terminalId ?? null;
				if (!id) {
					setDetail("starting a shell on the box…");
					id = (await withTimeout(api.pty.spawnShell({ taskId: task.id }), "spawnShell"))
						.terminalId;
				} else {
					setDetail("attaching to the live agent…");
				}
				if (cancelled) return;
				offData = api.pty.onData((e) => {
					if (e.terminalId !== id) return;
					if (!applied.current) {
						buffered.current.push(e);
						return;
					}
					if (e.seq > lastSeq.current) {
						lastSeq.current = e.seq;
						feed(e.data);
					}
				});
				offExit = api.pty.onExit((e) => {
					if (e.terminalId === id) setDetail(`session exited (code ${e.exitCode})`);
				});
				setTerminalId(id);
				setStatus("live");
			} catch (err) {
				if (cancelled) return;
				setStatus("error");
				setDetail(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			cancelled = true;
			offData();
			offExit();
		};
	}, [api, task.id, feed]);

	// The native view reports its size when laid out — use the first report as the
	// "ready" signal (mirrors the webview's ready): resize the PTY, paint the
	// snapshot, then flush chunks that streamed in while we were setting up.
	const onSizeChange = useCallback(
		async (cols: number, rows: number) => {
			const id = terminalId;
			if (!id) return;
			api.pty.resize(id, cols, rows);
			if (snapped.current) return;
			snapped.current = true;
			try {
				const snap = await api.pty.snapshot(id);
				if (snap.data) feed(snap.data);
				lastSeq.current = snap.seq;
				for (const c of buffered.current) {
					if (c.seq > lastSeq.current) {
						lastSeq.current = c.seq;
						feed(c.data);
					}
				}
			} finally {
				buffered.current = [];
				applied.current = true;
			}
		},
		[api, terminalId, feed],
	);

	const onInput = useCallback(
		(data: string) => {
			if (terminalId) api.pty.write(terminalId, data);
		},
		[api, terminalId],
	);

	// Shortcut-bar key → write bytes. Input keys keep the keyboard up; scroll keys
	// (PgUp/PgDn) must NOT pop the keyboard — you're reading, not typing.
	const send = useCallback(
		(bytes: string, scroll?: boolean) => {
			if (!terminalId) return;
			api.pty.write(terminalId, bytes);
			if (!scroll) termRef.current?.focusKeyboard();
		},
		[api, terminalId],
	);

	return (
		<KeyboardAvoidingView
			style={styles.root}
			behavior={Platform.OS === "ios" ? "padding" : undefined}
		>
			<View style={styles.header}>
				<Pressable style={styles.iconBtn} onPress={onClose} hitSlop={8}>
					<Text style={styles.iconChevron}>‹</Text>
				</Pressable>
				<Text style={styles.title} numberOfLines={1}>
					{task.name}
				</Text>
				<Pressable
					style={styles.kbdBtn}
					onPress={() => termRef.current?.blurKeyboard()}
					hitSlop={8}
				>
					<Text style={styles.kbdText}>Hide ⌨</Text>
				</Pressable>
				<View style={[styles.dot, { backgroundColor: status === "error" ? C.red : C.green }]} />
			</View>
			{terminalId ? (
				<>
					<SwiftTermView
						style={styles.term}
						onInput={onInput}
						onSizeChange={onSizeChange}
						ref={termRef}
					/>
					<ScrollView
						horizontal
						showsHorizontalScrollIndicator={false}
						style={styles.keyBar}
						contentContainerStyle={styles.keyBarContent}
						keyboardShouldPersistTaps="always"
					>
						{KEYS.map((k) => (
							<Pressable
								key={k.label}
								style={styles.key}
								onPress={() => send(k.bytes, k.scroll)}
								hitSlop={4}
							>
								<Text style={styles.keyText}>{k.label}</Text>
							</Pressable>
						))}
					</ScrollView>
				</>
			) : (
				<View style={styles.center}>
					{status === "error" ? (
						<>
							<Text style={styles.err}>{detail}</Text>
							<Pressable style={styles.retryBtn} onPress={onClose} hitSlop={8}>
								<Text style={styles.retryText}>Back to board</Text>
							</Pressable>
						</>
					) : (
						<>
							<ActivityIndicator color={C.ink} />
							<Text style={styles.hint}>{detail}</Text>
						</>
					)}
				</View>
			)}
		</KeyboardAvoidingView>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg, paddingTop: 60 },
	header: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingHorizontal: 14,
		paddingBottom: 12,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
	},
	iconBtn: {
		width: 34,
		height: 30,
		borderRadius: 8,
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
		alignItems: "center",
		justifyContent: "center",
	},
	iconChevron: { color: C.ink, fontSize: 20, fontWeight: "700", marginTop: -2 },
	title: { color: C.ink, fontSize: 15, fontWeight: "700", flex: 1 },
	kbdBtn: {
		paddingHorizontal: 10,
		height: 28,
		borderRadius: 7,
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
		alignItems: "center",
		justifyContent: "center",
	},
	kbdText: { color: C.muted, fontSize: 12, fontWeight: "600" },
	dot: { width: 8, height: 8, borderRadius: 4 },
	term: { flex: 1, backgroundColor: "#000" },
	// No maxHeight (it would clip the bottom padding). Horizontal scroll handles
	// overflow when the keys don't fit the width. Extra bottom padding lifts the row
	// off the iOS home indicator.
	keyBar: { flexGrow: 0, backgroundColor: C.surface, borderTopWidth: 1, borderTopColor: C.line },
	keyBarContent: {
		alignItems: "center",
		gap: 8,
		paddingHorizontal: 10,
		paddingTop: 8,
		paddingBottom: 30,
	},
	key: {
		minWidth: 44,
		height: 34,
		paddingHorizontal: 12,
		borderRadius: 8,
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
		alignItems: "center",
		justifyContent: "center",
	},
	keyText: { color: C.ink, fontSize: 14, fontWeight: "600" },
	retryBtn: {
		marginTop: 8,
		paddingHorizontal: 16,
		paddingVertical: 10,
		borderRadius: 8,
		backgroundColor: C.ink,
	},
	retryText: { color: "#15151a", fontSize: 13, fontWeight: "800" },
	center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
	hint: { color: C.muted, fontSize: 13 },
	err: { color: C.red, fontSize: 13, textAlign: "center", paddingHorizontal: 24 },
});
