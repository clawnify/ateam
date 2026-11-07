// The desktop's side of a voice call with the Lead: the window's mic, WebRTC
// and Web Audio for the call engine both apps share (@ateam/protocol
// lead-call.ts). Main opens the voice session (server lead/call.ts) so the
// OpenAI key stays out of the window.
import {
	type CallMedia,
	type CallMeter,
	type CallPeer,
	type CallStream,
	LeadCall,
} from "@ateam/protocol";

export { type CallView, heldReason, UNDO_MS } from "@ateam/protocol";

function browserMedia(): CallMedia {
	let ctx: AudioContext | null = null;
	let audio: HTMLAudioElement | null = null;
	return {
		async openMic() {
			const mic = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
			ctx = new AudioContext();
			return mic;
		},
		newPeer: () => new RTCPeerConnection() as unknown as CallPeer,
		play(track) {
			audio ??= Object.assign(new Audio(), { autoplay: true });
			audio.srcObject = new MediaStream([track as MediaStreamTrack]);
		},
		meter(mic: CallStream): CallMeter {
			if (!ctx) throw new Error("The call's audio isn't open.");
			const analyser = ctx.createAnalyser();
			analyser.fftSize = 1024;
			const source = ctx.createMediaStreamSource(mic as MediaStream);
			source.connect(analyser);
			const buf = new Float32Array(analyser.fftSize);
			return {
				level() {
					analyser.getFloatTimeDomainData(buf);
					let sum = 0;
					for (const v of buf) sum += v * v;
					return Math.sqrt(sum / buf.length);
				},
				stop: () => source.disconnect(),
			};
		},
		chime() {
			if (!ctx) return;
			const t = ctx.currentTime;
			for (const [i, f] of [660, 880].entries()) {
				const o = ctx.createOscillator();
				const g = ctx.createGain();
				o.frequency.value = f;
				g.gain.setValueAtTime(0.0001, t + i * 0.12);
				g.gain.exponentialRampToValueAtTime(0.15, t + i * 0.12 + 0.02);
				g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.11);
				o.connect(g).connect(ctx.destination);
				o.start(t + i * 0.12);
				o.stop(t + i * 0.12 + 0.12);
			}
		},
		close() {
			void ctx?.close();
			ctx = null;
		},
	};
}

/** One call per window, so it survives the chat moving between its tab and the sidebar. */
export const leadCall = new LeadCall(() => window.ateamLead, browserMedia());
