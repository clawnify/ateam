// The box's own terminal, outside every project: where a first visit signs into
// GitHub (gh auth login) or a secrets CLI before there is a project to open. One
// per box (pty:boxShell): leaving keeps it running, and every visit reopens it
// until `exit` ends it.
import type { AteamApi } from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import { useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { NativeTerminal } from "./NativeTerminalScreen";
import { StripBar } from "./TerminalStrip";
import { C } from "./theme";

export function BoxTerminalScreen({
	api,
	onClose,
	onUpdateBox,
	updating,
	updateError,
	boxAtLatest,
	run,
	onRan,
}: {
	api: AteamApi;
	onClose: () => void;
	/** A box older than this app has no box terminal; updating it brings one. */
	onUpdateBox: () => void;
	updating: boolean;
	updateError: string | null;
	/** An update came back on the same version: no release has the box terminal yet. */
	boxAtLatest: boolean;
	/** A command to type into it once it's open (sign in to an agent), then forgotten. */
	run?: string | null;
	onRan?: () => void;
}) {
	const [tooOld, setTooOld] = useState(false);
	// Read through refs, so `open` stays the same function and the terminal isn't
	// reopened when the command is spent.
	const pending = useRef(run);
	pending.current = run;
	const ran = useRef(onRan);
	ran.current = onRan;
	const open = useCallback(async () => {
		try {
			const { terminalId } = await api.pty.boxShell();
			const command = pending.current;
			if (command) {
				pending.current = null;
				api.pty.write(terminalId, `${command}\r`);
				ran.current?.();
			}
			return terminalId;
		} catch (err) {
			// What an engine from before the box terminal answers.
			if (err instanceof Error && /Unknown method/.test(err.message)) {
				setTooOld(true);
				return null;
			}
			throw err;
		}
	}, [api]);
	const strip = (
		<StripBar
			lead={<Feather name="terminal" size={12} color={C.ink} />}
			title="Box terminal"
			expanded
			onToggle={onClose}
		/>
	);

	if (!tooOld)
		return <NativeTerminal api={api} open={open} strip={strip} onClose={onClose} autoFocus />;
	return (
		<View style={styles.root}>
			{strip}
			<View style={styles.center}>
				<Text style={styles.text}>
					{boxAtLatest
						? "This box is on the latest Ateam release, which doesn't have the box terminal yet. It comes with the next release."
						: "This box runs an older Ateam, without the box terminal. Update the box to open it here."}
				</Text>
				{!boxAtLatest && (
					<Pressable
						style={[styles.btn, updating && styles.btnBusy]}
						onPress={onUpdateBox}
						disabled={updating}
					>
						<Text style={styles.btnText}>{updating ? "Updating…" : "Update box"}</Text>
					</Pressable>
				)}
				{updateError ? <Text style={styles.err}>{updateError}</Text> : null}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg },
	center: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		gap: 12,
		paddingHorizontal: 32,
	},
	text: { color: C.muted, fontSize: 13, textAlign: "center", lineHeight: 19 },
	btn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, backgroundColor: C.ink },
	btnBusy: { opacity: 0.6 },
	btnText: { color: "#15151a", fontSize: 13, fontWeight: "800" },
	err: { color: C.red, fontSize: 13, textAlign: "center" },
});
