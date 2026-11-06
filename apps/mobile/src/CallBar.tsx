// A call with the Lead on the phone: the call button in the Lead screen's head
// and the bar above its composer, the desktop's (LeadChat) on the phone's
// system call (src/lead-call.ts). The call goes on with the screen closed; the
// header's Lead button turns green meanwhile (App.tsx).
import { boxSupports, type CallView, heldReason, UNDO_MS } from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import {
	callsAvailable,
	leadCall,
	setCallMuted,
	setCallSpeaker,
	useCallSpeaker,
	useLeadCall,
} from "./lead-call";
import { loadCallNotice, saveCallNotice } from "./storage";
import { C } from "./theme";

function callWords(call: CallView): string {
	if (call.error) return call.error;
	if (call.state === "connecting") return "Calling the Lead…";
	if (call.paused) return "On hold while you're on another call.";
	if (call.state === "live")
		return call.muted
			? "Muted: nothing leaves this phone."
			: "On a call with the Lead. Talk any time.";
	if (call.state === "hold")
		return call.voiceWakePaused
			? "On hold. Lots of talk nearby, so speaking won't pick it up for now: tap Talk."
			: "On hold while it's quiet. Talk, or news from a task, picks it up.";
	return "";
}

/** Whether this phone can call at all (src/lead-call.ts callsAvailable). */
function useCallsAvailable(): boolean {
	const [on, setOn] = useState(false);
	useEffect(() => {
		let live = true;
		void callsAvailable().then((v) => live && setOn(v));
		return () => {
			live = false;
		};
	}, []);
	return on;
}

/** The call's own button, in the Lead screen's head: call, or hang up. */
export function CallButton({
	boxLabel,
	boxVersion,
	onUpdateBox,
}: {
	boxLabel?: string | null;
	boxVersion: number;
	onUpdateBox: () => void;
}) {
	const call = useLeadCall();
	const available = useCallsAvailable();
	if (!available) return null;
	const on = call.state !== "off";

	const start = async () => {
		if (!boxSupports("leadCallSession", boxVersion)) {
			Alert.alert(
				`Calls need a newer Ateam on ${boxLabel ?? "this box"}`,
				`This box runs v${boxVersion}. Calls with the Lead come with v33.`,
				[
					{ text: "Cancel", style: "cancel" },
					{ text: "Update box", onPress: onUpdateBox },
				],
			);
			return;
		}
		// Once, before the first call: where the voice goes (App Review 5.1.2).
		if (!(await loadCallNotice())) {
			Alert.alert(
				"Calls use OpenAI's voice",
				"During a call, this phone sends what you say to OpenAI, on the OpenAI key your box holds, and OpenAI's voice speaks the Lead's replies. What you say to the Lead goes into this chat. Ateam keeps no audio.",
				[
					{ text: "Not now", style: "cancel" },
					{
						text: "Call",
						onPress: () => {
							void saveCallNotice();
							void leadCall.start();
						},
					},
				],
			);
			return;
		}
		void leadCall.start();
	};

	return (
		<Pressable
			onPress={() => (on ? leadCall.hangUp() : void start())}
			hitSlop={10}
			accessibilityRole="button"
			accessibilityLabel={on ? "Hang up" : "Call the Lead"}
		>
			<Feather name={on ? "phone-off" : "phone"} size={16} color={on ? C.green : C.ink} />
		</Pressable>
	);
}

/** Above the composer: what the call is doing, what it held back, a yes counting down. */
export function CallBar() {
	const call = useLeadCall();
	const speaker = useCallSpeaker();
	const on = call.state !== "off";
	if (!on && !call.error && !call.held && !call.approving) return null;
	return (
		<View style={styles.wrap}>
			{call.approving && (
				<View style={styles.row}>
					<Text style={styles.words}>
						Going ahead in {UNDO_MS / 1000} s: {call.approving.text}
					</Text>
					<Button label="Undo" onPress={() => leadCall.undo()} />
				</View>
			)}
			{call.held && (
				<View style={styles.row}>
					<Text style={styles.words}>
						Didn't send "{call.held.text}": {heldReason(call.held.kind)}.
					</Text>
					<Button label="Send" onPress={() => leadCall.sendHeld()} />
				</View>
			)}
			{(on || call.error) && (
				<View style={styles.state}>
					<View style={styles.row}>
						{on && (
							<View
								style={[
									styles.dot,
									call.state === "live" && !call.muted && { backgroundColor: C.green },
									(call.state === "connecting" || call.muted) && { backgroundColor: C.amber },
								]}
							/>
						)}
						<Text style={[styles.words, !on && call.error ? styles.error : null]}>
							{callWords(call)}
						</Text>
					</View>
					{on && (
						<View style={styles.buttons}>
							{call.state === "hold" && !call.paused && (
								<Button label="Talk" onPress={() => leadCall.talk()} />
							)}
							<Button
								label={call.muted ? "Unmute" : "Mute"}
								pressed={call.muted}
								onPress={() => setCallMuted(!call.muted)}
							/>
							<Button label="Speaker" pressed={speaker} onPress={() => setCallSpeaker(!speaker)} />
							<Button label="Hang up" danger onPress={() => leadCall.hangUp()} />
						</View>
					)}
				</View>
			)}
		</View>
	);
}

function Button({
	label,
	onPress,
	pressed,
	danger,
}: {
	label: string;
	onPress: () => void;
	pressed?: boolean;
	danger?: boolean;
}) {
	return (
		<Pressable
			onPress={onPress}
			hitSlop={6}
			style={[styles.button, pressed && styles.buttonOn, danger && styles.danger]}
			accessibilityRole="button"
			accessibilityState={pressed === undefined ? undefined : { selected: pressed }}
		>
			<Text style={[styles.buttonText, danger && styles.dangerText]}>{label}</Text>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	wrap: { gap: 6 },
	state: { gap: 8 },
	row: { flexDirection: "row", alignItems: "center", gap: 8 },
	dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.faint },
	words: { flex: 1, color: C.muted, fontSize: 13, lineHeight: 18 },
	error: { color: C.red },
	buttons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
	button: {
		backgroundColor: C.sunken,
		borderRadius: 8,
		paddingHorizontal: 12,
		paddingVertical: 7,
	},
	buttonOn: { backgroundColor: C.line },
	buttonText: { color: C.ink, fontSize: 13, fontWeight: "600" },
	danger: { backgroundColor: "rgba(248, 113, 113, 0.16)" },
	dangerText: { color: C.red },
});
