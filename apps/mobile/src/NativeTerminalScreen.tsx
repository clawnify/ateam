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
	line: "#2a2a33",
	ink: "#e6e6ea",
	muted: "#9a9aa6",
	accent: "#7c5cff",
	red: "#f87171",
};

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
		(async () => {
			try {
				const live = await api.pty.listForTask(task.id);
				let id = live[0]?.terminalId ?? null;
				if (!id) {
					setDetail("starting a shell on the box…");
					id = (await api.pty.spawnShell({ taskId: task.id })).terminalId;
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

	return (
		<KeyboardAvoidingView
			style={styles.root}
			behavior={Platform.OS === "ios" ? "padding" : undefined}
		>
			<View style={styles.header}>
				<Pressable onPress={onClose} hitSlop={8}>
					<Text style={styles.back}>‹ Board</Text>
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
				<View style={[styles.dot, { backgroundColor: status === "error" ? C.red : C.accent }]} />
			</View>
			{terminalId ? (
				<SwiftTermView
					style={styles.term}
					onInput={onInput}
					onSizeChange={onSizeChange}
					ref={termRef}
				/>
			) : (
				<View style={styles.center}>
					{status === "error" ? (
						<Text style={styles.err}>{detail}</Text>
					) : (
						<>
							<ActivityIndicator color={C.accent} />
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
	back: { color: C.accent, fontSize: 15, fontWeight: "600" },
	title: { color: C.ink, fontSize: 15, fontWeight: "700", flex: 1 },
	kbdBtn: {
		paddingHorizontal: 10,
		height: 28,
		borderRadius: 7,
		backgroundColor: "#1c1c22",
		borderWidth: 1,
		borderColor: C.line,
		alignItems: "center",
		justifyContent: "center",
	},
	kbdText: { color: C.muted, fontSize: 12, fontWeight: "600" },
	dot: { width: 8, height: 8, borderRadius: 4 },
	term: { flex: 1, backgroundColor: "#000" },
	center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
	hint: { color: C.muted, fontSize: 13 },
	err: { color: C.red, fontSize: 13, textAlign: "center", paddingHorizontal: 24 },
});
