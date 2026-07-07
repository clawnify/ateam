// A live terminal on the box, for one task. Resolves the PTY the way the task
// model implies: if the task already has a live agent session (its Claude Code
// TUI running), ATTACH to it and replay its screen — you land in the running
// agent, not a fresh shell. Only if nothing is live do we spawn a login shell
// (type `claude` to start one). Detaching (Close/unmount) never kills the session,
// so the agent keeps working and you can reattach later — exactly like the desktop
// and connect-cli.
//
// xterm.js renders inside a WebView (a raw PTY stream is ANSI escapes — it needs a
// real terminal emulator). The bridge + snapshot/seq-dedupe mirror Terminal.tsx.

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
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { buildTerminalHtml } from "./terminal-html";

const C = {
	bg: "#0c0c0e",
	surface: "#141418",
	sunken: "#1c1c22",
	line: "#2a2a33",
	ink: "#e6e6ea",
	muted: "#9a9aa6",
	faint: "#6a6a75",
	accent: "#7c5cff",
	red: "#f87171",
};

// TUI control bytes — the keys a soft keyboard can't send, modeled on the row
// Termius surfaces for the Claude TUI (esc / shift-tab / arrows / slash).
const KEYS: { label: string; bytes: string; wide?: boolean }[] = [
	{ label: "esc", bytes: "\x1b" },
	{ label: "⇧tab", bytes: "\x1b[Z" },
	{ label: "/", bytes: "/" },
	{ label: "←", bytes: "\x1b[D" },
	{ label: "↑", bytes: "\x1b[A" },
	{ label: "↓", bytes: "\x1b[B" },
	{ label: "→", bytes: "\x1b[C" },
	{ label: "^C", bytes: "\x03" },
];

const HTML = buildTerminalHtml();

export function TerminalScreen({
	api,
	task,
	onClose,
}: {
	api: AteamApi;
	task: TaskDTO;
	onClose: () => void;
}) {
	const webRef = useRef<WebView>(null);
	const [terminalId, setTerminalId] = useState<string | null>(null);
	const [status, setStatus] = useState<"connecting" | "live" | "exited" | "error">("connecting");
	const [detail, setDetail] = useState<string>("resolving session…");

	// Snapshot/seq state (refs — must not trigger re-render on every PTY chunk).
	const buffered = useRef<PtyDataEvent[]>([]);
	const applied = useRef(false);
	const lastSeq = useRef(-1);
	// Pending redraw timers, cleared on unmount so we never resize a dead PTY.
	const redrawTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

	const inject = useCallback((data: string) => {
		// injectJavaScript evals a JS string; JSON.stringify makes `data` a safe
		// literal (control chars, quotes, newlines all escaped). `true;` suppresses
		// the "no return value" warning.
		webRef.current?.injectJavaScript(`window.__termWrite(${JSON.stringify(data)});true;`);
	}, []);

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

				// Subscribe BEFORE the snapshot so chunks arriving during it are buffered
				// and replayed in order (seq-dedupe) — never doubled, never dropped.
				offData = api.pty.onData((e) => {
					if (e.terminalId !== id) return;
					if (!applied.current) {
						buffered.current.push(e);
						return;
					}
					if (e.seq > lastSeq.current) {
						lastSeq.current = e.seq;
						inject(e.data);
					}
				});
				offExit = api.pty.onExit((e) => {
					if (e.terminalId === id) {
						setStatus("exited");
						setDetail(`session exited (code ${e.exitCode})`);
					}
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
			for (const t of redrawTimers.current) clearTimeout(t);
			// Detach only — the session (and the running agent) lives on.
		};
	}, [api, task.id, inject]);

	// Bridge messages from the webview (xterm) back to the PTY.
	const onMessage = useCallback(
		async (e: WebViewMessageEvent) => {
			const id = terminalId;
			if (!id) return;
			let msg: { type: string; data?: string; cols?: number; rows?: number };
			try {
				msg = JSON.parse(e.nativeEvent.data);
			} catch {
				return;
			}
			if (msg.type === "input" && typeof msg.data === "string") {
				api.pty.write(id, msg.data);
			} else if (msg.type === "resize" && msg.cols && msg.rows) {
				api.pty.resize(id, msg.cols, msg.rows);
			} else if (msg.type === "ready") {
				// xterm is mounted: size the PTY, paint its current screen, then flush
				// any chunks that streamed in while we were setting up.
				const cols = msg.cols ?? 80;
				const rows = msg.rows ?? 24;
				api.pty.resize(id, cols, rows);
				try {
					const snap = await api.pty.snapshot(id);
					if (snap.data) inject(snap.data);
					lastSeq.current = snap.seq;
					for (const c of buffered.current) {
						if (c.seq > lastSeq.current) {
							lastSeq.current = c.seq;
							inject(c.data);
						}
					}
				} finally {
					buffered.current = [];
					applied.current = true;
				}
				// Force a full repaint. A same-size reattach fires no SIGWINCH, so a
				// running full-screen TUI (Claude Code) never redraws its live UI — you
				// see only the replayed scrollback, missing the input box/footer. Jiggle
				// the size (rows-1 → rows) to trigger SIGWINCH; the TUI then repaints
				// everything from scratch (authoritative — better than trusting the
				// serialized snapshot for alt-screen content).
				//
				// The gaps are deliberately generous: a heavy TUI needs time to process
				// each SIGWINCH and finish its redraw before the next size lands, or the
				// second resize interrupts a mid-flight repaint and the input box comes
				// back partial. Let it settle, shrink, let THAT redraw finish, then grow.
				for (const t of redrawTimers.current) clearTimeout(t);
				redrawTimers.current = [
					setTimeout(() => api.pty.resize(id, cols, Math.max(1, rows - 1)), 350),
					setTimeout(() => api.pty.resize(id, cols, rows), 900),
				];
			}
		},
		[api, terminalId, inject],
	);

	const send = useCallback(
		(bytes: string) => {
			if (terminalId) {
				api.pty.write(terminalId, bytes);
				webRef.current?.injectJavaScript("window.__termFocus();true;");
			}
		},
		[api, terminalId],
	);

	return (
		<KeyboardAvoidingView
			style={styles.root}
			behavior={Platform.OS === "ios" ? "padding" : undefined}
		>
			<View style={styles.header}>
				<Pressable style={styles.closeBtn} onPress={onClose} hitSlop={8}>
					<Text style={styles.closeText}>‹ Board</Text>
				</Pressable>
				<Text style={styles.title} numberOfLines={1}>
					{task.name}
				</Text>
				<View style={[styles.dot, { backgroundColor: statusColor(status) }]} />
			</View>

			<View style={styles.termWrap}>
				{terminalId ? (
					<WebView
						ref={webRef}
						source={{ html: HTML }}
						originWhitelist={["*"]}
						onMessage={onMessage}
						// Let xterm focus its hidden input and pop the keyboard without a
						// prior user tap (iOS gates this by default).
						keyboardDisplayRequiresUserAction={false}
						style={styles.web}
						// Terminal owns its own scrollback; don't double-scroll.
						scrollEnabled={false}
						overScrollMode="never"
						hideKeyboardAccessoryView
					/>
				) : (
					<View style={styles.center}>
						{status === "error" ? (
							<Text style={styles.errText}>{detail}</Text>
						) : (
							<>
								<ActivityIndicator color={C.accent} />
								<Text style={styles.hint}>{detail}</Text>
							</>
						)}
					</View>
				)}
			</View>

			{/* TUI key toolbar (soft keyboard can't send these). */}
			<ScrollView
				horizontal
				showsHorizontalScrollIndicator={false}
				style={styles.keyBar}
				contentContainerStyle={styles.keyBarContent}
				keyboardShouldPersistTaps="always"
			>
				{KEYS.map((k) => (
					<Pressable key={k.label} style={styles.key} onPress={() => send(k.bytes)} hitSlop={4}>
						<Text style={styles.keyText}>{k.label}</Text>
					</Pressable>
				))}
			</ScrollView>
		</KeyboardAvoidingView>
	);
}

function statusColor(s: "connecting" | "live" | "exited" | "error"): string {
	if (s === "live") return "#4ade80";
	if (s === "error") return C.red;
	if (s === "exited") return C.faint;
	return "#fbbf24";
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
	closeBtn: { paddingVertical: 4, paddingRight: 4 },
	closeText: { color: C.accent, fontSize: 15, fontWeight: "600" },
	title: { color: C.ink, fontSize: 15, fontWeight: "700", flex: 1 },
	dot: { width: 8, height: 8, borderRadius: 4 },
	termWrap: { flex: 1, backgroundColor: "#000" },
	web: { flex: 1, backgroundColor: "#000" },
	center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
	hint: { color: C.muted, fontSize: 13 },
	errText: {
		color: C.red,
		fontSize: 13,
		textAlign: "center",
		paddingHorizontal: 24,
		lineHeight: 18,
	},
	keyBar: {
		maxHeight: 48,
		backgroundColor: C.surface,
		borderTopWidth: 1,
		borderTopColor: C.line,
	},
	keyBarContent: { alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 7 },
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
});
