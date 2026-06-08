import { AlertTriangle, CheckCircle2, Play, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { LoopDTO } from "../../../shared/types";

/** "in 45s" / "in 2m" / "now", or "—" when no next run is scheduled. */
function untilLabel(nextRunAt: number | null, now: number): string {
	if (nextRunAt == null) return "—";
	const ms = nextRunAt - now;
	if (ms <= 0) return "now";
	const s = Math.round(ms / 1000);
	if (s < 60) return `in ${s}s`;
	return `in ${Math.round(s / 60)}m`;
}

/** "12s ago" / "3m ago" / "never". */
function agoLabel(lastRunAt: number | null, now: number): string {
	if (lastRunAt == null) return "never";
	const s = Math.round((now - lastRunAt) / 1000);
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	return `${Math.round(s / 3600)}h ago`;
}

/**
 * The Loops panel: lists every registered loop (the board reconciler and any
 * future ones), with its last-run summary, next-run countdown, an enable
 * toggle, and a run-now button. Stays live via the loops:updated push event and
 * a 1s tick so the countdowns move.
 */
export function LoopsPanel() {
	const [loops, setLoops] = useState<LoopDTO[]>([]);
	const [busy, setBusy] = useState<string | null>(null);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		void window.ateam.loops.list().then(setLoops);
		const off = window.ateam.loops.onUpdated(setLoops);
		const tick = setInterval(() => setNow(Date.now()), 1000);
		return () => {
			off();
			clearInterval(tick);
		};
	}, []);

	const toggle = async (l: LoopDTO) => {
		setLoops(await window.ateam.loops.setEnabled(l.id, !l.enabled));
	};
	const runNow = async (l: LoopDTO) => {
		setBusy(l.id);
		try {
			setLoops(await window.ateam.loops.runNow(l.id));
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="loops">
			<div className="loops-head">
				<h2>Loops</h2>
				<p className="muted">
					Background reconcilers that keep the board honest. Each runs on its own cadence — tight
					while agents are active, relaxed when the board is quiet.
				</p>
			</div>

			{loops.length === 0 && <div className="empty">No loops registered.</div>}

			{loops.map((l) => (
				<div key={l.id} className={`loop-card ${l.enabled ? "" : "off"}`}>
					<div className="loop-main">
						<div className="loop-title">
							<span>{l.title}</span>
							<span className="loop-cadence muted">
								{l.cadence === "self_paced" ? "self-paced" : "fixed"}
							</span>
						</div>
						<div className="loop-desc muted">{l.description}</div>
						<div className="loop-meta">
							{l.lastStatus === "error" ? (
								<span className="loop-stat err">
									<AlertTriangle size={13} /> {l.lastError ?? "error"}
								</span>
							) : (
								<span className="loop-stat ok">
									<CheckCircle2 size={13} />
									{l.lastSummary ?? "not run yet"}
								</span>
							)}
							<span className="muted">· ran {agoLabel(l.lastRunAt, now)}</span>
							<span className="muted">· {l.runs} runs</span>
							{l.enabled && <span className="muted">· next {untilLabel(l.nextRunAt, now)}</span>}
						</div>
					</div>

					<div className="loop-actions">
						<button
							type="button"
							className="navbtn"
							onClick={() => runNow(l)}
							disabled={busy === l.id}
							title="Run this loop now"
						>
							{busy === l.id ? <RefreshCw size={14} className="spin" /> : <Play size={14} />}
							Run now
						</button>
						<label className="loop-toggle" title="Enable or pause this loop">
							<input type="checkbox" checked={l.enabled} onChange={() => void toggle(l)} />
							<span>{l.enabled ? "On" : "Off"}</span>
						</label>
					</div>
				</div>
			))}
		</div>
	);
}
