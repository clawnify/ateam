// The steps of waking and reaching a box, one per line: the same ones Ateam Go
// shows under a box's card (connect-steps in @ateam/protocol). A woken box can take
// minutes to answer, and a bare "Connecting…" for that long reads as stuck.
import type { ConnectStep } from "@ateam/protocol";
import { Check, RefreshCw, X } from "lucide-react";

export function ConnectSteps({ steps }: { steps: ConnectStep[] }) {
	return (
		<ul className="conn-steps" aria-live="polite">
			{steps.map((s, i) => (
				<li key={`${i}:${s.status}`} className={`conn-step ${s.status}`}>
					{s.status === "active" ? (
						<RefreshCw size={11} strokeWidth={2.25} className="spin" />
					) : s.status === "done" ? (
						<Check size={11} strokeWidth={2.5} />
					) : (
						<X size={11} strokeWidth={2.5} />
					)}
					<span>{s.label}</span>
				</li>
			))}
		</ul>
	);
}
