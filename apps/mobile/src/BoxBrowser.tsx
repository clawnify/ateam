// A box task's browser: the box's Chrome (install-browser.sh) in noVNC, the view
// the desktop's Browser panel opens. It sits over the terminal as a miniature in
// the top right; a tap moves it above the terminal, and its minimize button puts
// it back. It is one WebView in one place in the tree whichever way it shows, so
// switching only restyles it and the VNC session never reconnects.
//
// It is only mounted for a task whose agent has used the browser
// (TaskDTO.browserUsedAt), and a box without one shows nothing.
import type { AteamApi } from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { loadBrowserView } from "./load-browser-view";
import { C } from "./theme";

export function BoxBrowser({
	api,
	taskId,
	expanded,
	onExpanded,
}: {
	api: AteamApi;
	taskId: string;
	/** Above the terminal (true) or a miniature over its top right (false). */
	expanded: boolean;
	onExpanded: (expanded: boolean) => void;
}) {
	const [url, setUrl] = useState<string | null>(null);

	// Hidden until the box answers, however long that takes (load-browser-view.ts).
	useEffect(() => loadBrowserView(api, taskId, setUrl), [api, taskId]);

	if (!url) return null;
	return (
		<View style={expanded ? styles.slotOpen : styles.slotMini}>
			<View style={expanded ? styles.frameOpen : styles.frameMini}>
				<WebView
					source={{ uri: url }}
					style={styles.web}
					originWhitelist={["*"]}
					// noVNC sizes its own canvas; page zoom would fight its scaling.
					scalesPageToFit={false}
					bounces={false}
					injectedJavaScriptBeforeContentLoaded={SCREEN_ONLY}
				/>
				{expanded ? (
					<Pressable
						style={styles.minimize}
						onPress={() => onExpanded(false)}
						hitSlop={8}
						accessibilityRole="button"
						accessibilityLabel="Shrink the browser"
					>
						<Feather name="minimize-2" size={13} color={C.ink} />
					</Pressable>
				) : (
					// The miniature is a preview, not a remote control: a tap opens it.
					<Pressable
						style={StyleSheet.absoluteFill}
						onPress={() => onExpanded(true)}
						accessibilityRole="button"
						accessibilityLabel="Open the box's browser"
					/>
				)}
			</View>
		</View>
	);
}

// Only the box's screen, as Clawnify's viewer shows it: noVNC's control bar, its
// hint arrow and its status pop-ups are hidden (ids from noVNC 1.x vnc.html). Its
// "Connecting…" overlay stays, so a dropped view never passes for a frozen one.
const SCREEN_ONLY = `(function () {
	var s = document.createElement("style");
	s.textContent = "#noVNC_control_bar_anchor, #noVNC_hint_anchor, #noVNC_status { display: none !important; }";
	document.documentElement.appendChild(s);
})();
true;`;

// The box's desktop is 1280x720, so the miniature keeps 16:9.
const MINI_W = 144;

const styles = StyleSheet.create({
	// Zero height in the column, drawn over the terminal below it.
	slotMini: { height: 0, zIndex: 2 },
	// Full width at the desktop's own 16:9, so the view has no bars to letterbox
	// and the terminal keeps the rest.
	slotOpen: {
		width: "100%",
		aspectRatio: 16 / 9,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
	},
	frameMini: {
		position: "absolute",
		top: 8,
		right: 8,
		width: MINI_W,
		height: (MINI_W * 9) / 16,
		borderRadius: 6,
		borderWidth: 1,
		borderColor: C.line,
		overflow: "hidden",
		backgroundColor: C.bg,
	},
	frameOpen: { flex: 1, backgroundColor: C.bg },
	web: { flex: 1, backgroundColor: C.bg },
	minimize: {
		position: "absolute",
		top: 6,
		right: 6,
		width: 26,
		height: 26,
		borderRadius: 13,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "rgba(12,12,14,0.8)",
	},
});
