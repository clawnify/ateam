// Ateam Go's side of a call with the Lead: react-native-webrtc and the system
// call (modules/expo-lead-call: CallKit, the mic's level on hold, the chime)
// for the call engine both apps share (@ateam/protocol lead-call.ts). The box
// opens the voice session with its own OpenAI key (protocol v33), so no key is
// ever on the phone.
import {
	type CallLead,
	type CallMedia,
	type CallPeer,
	type CallStream,
	type CallView,
	LeadCall,
} from "@ateam/protocol";
import { useSyncExternalStore } from "react";
import { mediaDevices, RTCAudioSession, RTCPeerConnection } from "react-native-webrtc";
import { systemCall } from "../modules/expo-lead-call/src";

/** The box whose Lead the call is with, and its name on the system call screen. */
let target: { box: string | null; lead: CallLead | null; name: string } = {
	box: null,
	lead: null,
	name: "Lead",
};
/** The box and connection the call started on, or last relinked to. */
let linked: { box: string | null; lead: CallLead | null } = { box: null, lead: null };

const media: CallMedia = {
	async openMic() {
		if (!systemCall)
			throw new Error("This Ateam Go can't make calls: update it from the App Store.");
		if (!(await systemCall.requestMic()))
			throw new Error("Ateam Go can't hear you: allow the microphone in Settings → Ateam Go.");
		await systemCall.start(target.name);
		// CallKit gave the call its audio session: WebRTC may use it now.
		RTCAudioSession.audioSessionDidActivate();
		try {
			return (await mediaDevices.getUserMedia({
				audio: true,
				video: false,
			})) as unknown as CallStream;
		} catch (e) {
			systemCall.end();
			throw e;
		}
	},
	newPeer: () => new RTCPeerConnection() as unknown as CallPeer,
	meter() {
		systemCall?.startMeter();
		return { level: () => systemCall?.level() ?? 0, stop: () => systemCall?.stopMeter() };
	},
	chime: () => systemCall?.chime(),
	close: () => systemCall?.end(),
};

/** The one call, so it goes on with the Lead's screen closed. */
export const leadCall = new LeadCall(() => {
	if (!target.lead) throw new Error("Ateam Go lost its connection to the box.");
	return target.lead;
}, media);

/** The app's Lead as it changes. A reconnect mid-call is listened on; the
 *  Lead moving to another box ends the call, which was with the first one. */
export function setCallTarget(box: string | null, lead: CallLead | null, name: string): void {
	target = { box, lead, name };
	if (leadCall.state === "off") {
		linked = { box, lead };
		return;
	}
	if (box !== linked.box) leadCall.hangUp("The Lead moved to another box, so the call ended.");
	else if (lead && lead !== linked.lead) {
		linked = { box, lead };
		leadCall.relink();
	}
}

/** Mute through the system call, so its screen and the lock screen agree. */
export function setCallMuted(muted: boolean): void {
	if (systemCall && leadCall.state !== "off") systemCall.setMuted(muted);
	else leadCall.setMuted(muted);
}

/** Whether this phone can call: false where CallKit isn't allowed (mainland
 *  China, the user's decision) and in a build without the module. Asked once. */
let available: Promise<boolean> | null = null;
export function callsAvailable(): Promise<boolean> {
	available ??= systemCall ? systemCall.available().catch(() => false) : Promise.resolve(false);
	return available;
}

/** The call as the screens show it. */
export function useLeadCall(): CallView {
	return useSyncExternalStore(
		(cb) => leadCall.subscribe(cb),
		() => leadCall.view,
	);
}

// The speaker instead of the earpiece, for this call only.
let speaker = false;
const speakerListeners = new Set<() => void>();
function setSpeakerState(on: boolean): void {
	speaker = on;
	for (const l of speakerListeners) l();
}

export function setCallSpeaker(on: boolean): void {
	systemCall?.setSpeaker(on);
	setSpeakerState(on);
}

export function useCallSpeaker(): boolean {
	return useSyncExternalStore(
		(cb) => {
			speakerListeners.add(cb);
			return () => speakerListeners.delete(cb);
		},
		() => speaker,
	);
}

// What the system does to the call: the lock screen, the system call screen,
// a real phone call.
if (systemCall) {
	systemCall.addListener("onActivate", () => {
		RTCAudioSession.audioSessionDidActivate();
		// A real call's hold is over: the session is the call's again.
		if (leadCall.view.paused) leadCall.setPaused(false);
	});
	systemCall.addListener("onDeactivate", () => RTCAudioSession.audioSessionDidDeactivate());
	systemCall.addListener("onEnd", () => leadCall.hangUp());
	systemCall.addListener("onMute", ({ muted }) => {
		if (leadCall.view.muted !== muted) leadCall.setMuted(muted);
	});
	// The speaker went off by itself: a headset connected.
	systemCall.addListener("onSpeaker", ({ on }) => setSpeakerState(on));
	// Given back, the call waits for its audio session (onActivate).
	systemCall.addListener("onHold", ({ held }) => {
		if (held) leadCall.setPaused(true);
	});
	// The system call screen counts the call's time from the first live session.
	let reported = false;
	leadCall.subscribe(() => {
		const state = leadCall.view.state;
		if (state === "off") {
			reported = false;
			if (speaker) setSpeakerState(false);
		} else if (state === "live" && !reported) {
			reported = true;
			systemCall?.connected();
		}
	});
}
