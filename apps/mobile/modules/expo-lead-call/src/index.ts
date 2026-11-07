import { NativeModule, requireOptionalNativeModule } from "expo";

type SystemCallEvents = {
	/** The system gave the call its audio session back (after a real call's hold). */
	onActivate(): void;
	/** The system took the call's audio session (a real call, the call ending). */
	onDeactivate(): void;
	/** Ended in the system call screen, on the lock screen, or by a real call. */
	onEnd(): void;
	/** Muted or unmuted, here or in the system call screen. */
	onMute(e: { muted: boolean }): void;
	/** A real call put this one on hold (Hold & Accept), or gave it back. */
	onHold(e: { held: boolean }): void;
	/** The speaker went off by itself: a headset (AirPods) connected. */
	onSpeaker(e: { on: boolean }): void;
};

// As Expo's own modules declare theirs (expo-camera's CameraNativeModule).
declare class SystemCall extends NativeModule<SystemCallEvents> {
	/** False where calls are off: mainland China, where CallKit isn't allowed. */
	available(): Promise<boolean>;
	/** Asks for the mic the first time; false when the user said no. */
	requestMic(): Promise<boolean>;
	/** Starts the system call; resolves once its audio session is active. */
	start(name: string): Promise<void>;
	/** The call is up: the system call screen starts its timer. */
	connected(): void;
	end(): void;
	/** Through the system call, which answers with onMute. */
	setMuted(muted: boolean): void;
	setSpeaker(on: boolean): void;
	/** Measures the mic while no WebRTC session has it; throws when it can't. */
	startMeter(): void;
	stopMeter(): void;
	/** The mic's level now: RMS, 0..1. */
	level(): number;
	chime(): void;
}

/** The phone's system call (CallKit), or null in a build that predates it. */
export const systemCall = requireOptionalNativeModule<SystemCall>("ExpoLeadCall");
