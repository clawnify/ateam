// SPIKE: a terminal backed by the native SwiftTerm view instead of xterm-in-webview.
// Same PTY contract (attach-if-live / spawn, snapshot+seq, onData→feed, input→write,
// size→resize) — only the renderer changes. SwiftTerm is a native UIScrollView, so
// scroll / selection / copy are native (the whole reason for the swap). Kept
// separate from TerminalScreen so the webview path stays intact while we evaluate.

import type { AteamApi, TaskDTO } from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	Keyboard,
	Linking,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import {
	type SwiftTermHandle,
	SwiftTermView,
} from "../modules/expo-swiftterm/src/ExpoSwifttermView";
import { KeyBar, keyStyles } from "./KeyBar";
import { TerminalStrip } from "./TerminalStrip";
import { useKeyboardVisible } from "./useKeyboardVisible";
import { useTaskPty } from "./useTaskPty";

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

// A URL tapped in the terminal output. Only web links leave the app (a TUI can
// print anything that looks like a link, including file: and custom schemes).
function openTappedLink(url: string) {
	if (!/^https?:\/\//i.test(url)) return;
	void Linking.openURL(url);
}

// Backslash-escape shell-special chars so a typed path survives the shell — same
// convention the desktop terminal uses for dropped/attached file paths.
const escapePath = (p: string) => p.replace(/([ '"\\!$&*()[\]{};<>?#~`|])/g, "\\$1");

// Best-effort file extension for the staged image (the server sanitizes it anyway).
function extFromAsset(a: ImagePicker.ImagePickerAsset): string {
	const fromMime = a.mimeType?.split("/")[1];
	if (fromMime) return fromMime;
	return a.uri.match(/\.([a-z0-9]+)$/i)?.[1] ?? "png";
}

export function NativeTerminalScreen({
	api,
	task,
	onClose,
	autoFocus = false,
}: {
	api: AteamApi;
	task: TaskDTO;
	onClose: () => void;
	/** Bring the keyboard up as soon as the terminal is ready (expanding from a
	 *  Mission Control tile to type). */
	autoFocus?: boolean;
}) {
	const termRef = useRef<SwiftTermHandle>(null);
	const [attaching, setAttaching] = useState(false);
	const keyboardUp = useKeyboardVisible();

	const feed = useCallback((data: string) => termRef.current?.feed(data), []);
	// Same PTY contract as Mission Control's tiles (attach-if-live), plus: spawn a
	// shell when the task has none, and size the PTY to this view.
	const pty = useTaskPty({ api, taskId: task.id, feed, spawnIfNone: true, resizePty: true });
	const { terminalId, status, lastSize, onSizeChange } = pty;
	const [detail, setDetail] = useState<string | null>(null);
	const shownDetail = detail ?? pty.detail;

	const onInput = pty.write;

	useEffect(() => {
		if (autoFocus && status === "live") termRef.current?.focusKeyboard();
	}, [autoFocus, status]);

	// The terminal grows/shrinks with the keyboard (KeyboardAvoidingView). A
	// full-screen TUI (Claude agents) doesn't always repaint cleanly after the rapid
	// resize animation, so once it settles, nudge a repaint: jiggle the size (rows-1
	// → rows) to force a SIGWINCH-driven full redraw at the final dimensions.
	// Listens to frame changes (not show/hide): the native view hides the keyboard
	// by swapping in an empty input view, which iOS reports as a frame change.
	// biome-ignore lint/correctness/useExhaustiveDependencies: lastSize is a ref from the hook
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const settle = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				const id = terminalId;
				const { cols, rows } = lastSize.current;
				if (!id || !cols || !rows) return;
				api.pty.resize(id, cols, Math.max(1, rows - 1));
				setTimeout(() => api.pty.resize(id, cols, rows), 120);
			}, 350);
		};
		const sub = Keyboard.addListener("keyboardDidChangeFrame", settle);
		return () => {
			sub.remove();
			if (timer) clearTimeout(timer);
		};
	}, [api, terminalId]);

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

	// Attach a photo/screenshot to the agent: pick → stage the bytes on the box
	// (util.writeImageBytes) → TYPE the returned path into the PTY. Typed keystrokes
	// (not a paste) are what trigger the agent's "path → [Image #N]" detection — same
	// mechanism the desktop terminal uses on a file drop.
	const attachImage = useCallback(async () => {
		const id = terminalId;
		if (!id || attaching) return;
		try {
			const res = await ImagePicker.launchImageLibraryAsync({
				mediaTypes: ["images"],
				base64: true,
				quality: 0.9,
			});
			const asset = res.canceled ? null : res.assets[0];
			if (!asset?.base64) return;
			setAttaching(true);
			const path = await api.utils.writeImageBytes(asset.base64, extFromAsset(asset));
			api.pty.write(id, `${escapePath(path)} `);
			termRef.current?.focusKeyboard();
		} catch (err) {
			setDetail(err instanceof Error ? err.message : "couldn't attach image");
		} finally {
			setAttaching(false);
		}
	}, [api, terminalId, attaching]);

	return (
		// Rendered under the shell's navbar (which already avoids the keyboard).
		<View style={styles.root}>
			<TerminalStrip task={task} expanded onToggle={onClose} />
			{terminalId ? (
				<>
					<SwiftTermView
						style={styles.term}
						onInput={onInput}
						onSizeChange={onSizeChange}
						onOpenLink={openTappedLink}
						ref={termRef}
					/>
					<KeyBar
						keyboardUp={keyboardUp}
						onKey={send}
						leading={
							<>
								{/* Back is the first key: the navbar above stays the shell's. */}
								<Pressable style={keyStyles.key} onPress={onClose} hitSlop={4}>
									<Feather name="arrow-left" size={16} color={C.ink} />
								</Pressable>
								<Pressable
									style={keyStyles.key}
									onPress={attachImage}
									disabled={attaching}
									hitSlop={4}
								>
									{attaching ? (
										<ActivityIndicator color={C.ink} size="small" />
									) : (
										<Feather name="paperclip" size={16} color={C.ink} />
									)}
								</Pressable>
							</>
						}
						trailing={
							<Pressable
								style={keyStyles.key}
								onPress={() => termRef.current?.blurKeyboard()}
								hitSlop={4}
							>
								<Feather name="chevron-down" size={16} color={C.ink} />
							</Pressable>
						}
					/>
				</>
			) : (
				<View style={styles.center}>
					{status === "error" ? (
						<>
							<Text style={styles.err}>{shownDetail}</Text>
							<Pressable style={styles.retryBtn} onPress={onClose} hitSlop={8}>
								<Text style={styles.retryText}>Back to board</Text>
							</Pressable>
						</>
					) : (
						<>
							<ActivityIndicator color={C.ink} />
							<Text style={styles.hint}>{shownDetail}</Text>
						</>
					)}
				</View>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg },
	term: { flex: 1, backgroundColor: "#000" },
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
