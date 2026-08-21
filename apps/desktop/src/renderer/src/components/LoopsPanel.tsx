import type { AgentDTO, LoopDTO, ProjectDTO } from "@ateam/protocol";
import { AlertTriangle, CheckCircle2, Play, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

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

/** "every 5m" / "every 2h". */
function everyLabel(intervalMs: number | null): string {
	if (intervalMs == null) return "";
	const min = Math.round(intervalMs / 60_000);
	return min < 60 ? `every ${min}m` : `every ${Math.round(min / 60)}h`;
}

// id → owning-engine alias (null/absent = this Mac), from the host's learned registry.
type Origins = Record<string, string | null>;

function envLabel(origins: Origins, id: string): string {
	return origins[id] ?? "Local";
}

/** Inline form for creating a loop: a scheduled agent session on an environment. */
function NewLoopForm({
	projects,
	agents,
	origins,
	onCreate,
	onCancel,
}: {
	projects: ProjectDTO[];
	agents: AgentDTO[];
	origins: Origins;
	onCreate: (loops: LoopDTO[]) => void;
	onCancel: () => void;
}) {
	const [name, setName] = useState("");
	const [prompt, setPrompt] = useState("");
	const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
	const [agentId, setAgentId] = useState(agents.find((a) => a.available)?.id ?? "claude");
	const [everyMin, setEveryMin] = useState("60");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const ready = prompt.trim() && projectId && Number(everyMin) >= 1;

	const submit = async () => {
		if (!ready) return;
		setSaving(true);
		setError(null);
		try {
			// The chosen project decides the environment: its engine (this Mac or a
			// box) owns the loop and runs every session there.
			await window.ateam.loops.create({
				templateId: "agent-session",
				name: name.trim() || "Loop",
				projectId,
				intervalMs: Number(everyMin) * 60_000,
				config: { prompt: prompt.trim(), agentId },
			});
			// Re-list rather than trust the call's return: the create ran on ONE
			// engine and returns only its loops — the panel shows the merged view.
			onCreate(await window.ateam.loops.list());
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="loop-card loop-form">
			<div className="loop-main">
				<div className="loop-form-row">
					<label>
						Name
						<input
							value={name}
							placeholder="Nightly deps"
							onChange={(e) => setName(e.target.value)}
						/>
					</label>
					<label>
						Agent
						<select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
							{agents.map((a) => (
								<option key={a.id} value={a.id}>
									{a.label}
								</option>
							))}
						</select>
					</label>
				</div>
				<div className="loop-form-row">
					<label>
						Project · environment
						<select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
							{projects.map((p) => (
								<option key={p.id} value={p.id}>
									{p.name} — {envLabel(origins, p.id)}
								</option>
							))}
						</select>
					</label>
					<label>
						Every (min)
						<input
							type="number"
							min={1}
							value={everyMin}
							onChange={(e) => setEveryMin(e.target.value)}
						/>
					</label>
				</div>
				<div className="loop-form-row">
					<label>
						Prompt — each run starts a fresh session with exactly this
						<textarea
							value={prompt}
							placeholder="Update dependencies and open a PR."
							onChange={(e) => setPrompt(e.target.value)}
						/>
					</label>
				</div>
				{error && (
					<div className="loop-stat err">
						<AlertTriangle size={13} /> {error}
					</div>
				)}
			</div>
			<div className="loop-actions">
				<button type="button" className="navbtn" onClick={submit} disabled={saving || !ready}>
					<Plus size={14} /> Create
				</button>
				<button type="button" className="navbtn" onClick={onCancel}>
					<X size={14} /> Cancel
				</button>
			</div>
		</div>
	);
}

/**
 * The Loops panel. A loop is deliberately user-created and nothing else: on its
 * interval it starts the chosen coding agent in a fresh task with the same
 * prompt, on the environment (this Mac or a box) where its project lives.
 * Stays live via the loops:updated push event and a 1s tick.
 */
export function LoopsPanel() {
	const [loops, setLoops] = useState<LoopDTO[]>([]);
	const [projects, setProjects] = useState<ProjectDTO[]>([]);
	const [agents, setAgents] = useState<AgentDTO[]>([]);
	const [origins, setOrigins] = useState<Origins>({});
	const [busy, setBusy] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		// Load the merged lists first — the host learns which engine owns each id
		// during those reads — then ask it for the origins map to label rows with.
		void Promise.all([
			window.ateam.loops.list().then(setLoops),
			window.ateam.projects.list().then(setProjects),
			window.ateam.agents.list().then((a) => setAgents(a.filter((x) => x.available))),
		]).then(async () => setOrigins(await window.ateamHost.origins()));
		// A mutation's return and the push event both carry ONE engine's loops;
		// the panel shows the union across engines, so always re-list.
		const refresh = () => void window.ateam.loops.list().then(setLoops);
		const off = window.ateam.loops.onUpdated(refresh);
		const tick = setInterval(() => setNow(Date.now()), 1000);
		return () => {
			off();
			clearInterval(tick);
		};
	}, []);

	const refresh = async () => setLoops(await window.ateam.loops.list());
	const toggle = async (l: LoopDTO) => {
		await window.ateam.loops.setEnabled(l.id, !l.enabled);
		await refresh();
	};
	const runNow = async (l: LoopDTO) => {
		setBusy(l.id);
		try {
			await window.ateam.loops.runNow(l.id);
			await refresh();
		} finally {
			setBusy(null);
		}
	};
	const remove = async (l: LoopDTO) => {
		await window.ateam.loops.remove(l.id);
		await refresh();
	};

	return (
		<div className="loops">
			<div className="loops-head">
				<div className="loops-head-row">
					<h2>Loops</h2>
					<button
						type="button"
						className="navbtn"
						onClick={() => setCreating((c) => !c)}
						disabled={projects.length === 0}
					>
						<Plus size={14} /> New loop
					</button>
				</div>
				<p className="muted">
					A loop starts a coding-agent session with the same prompt on a schedule — each run is a
					fresh task on the board, on this Mac or a box (wherever the loop's project lives). Loops
					only exist when you create them.
				</p>
			</div>

			{creating && (
				<NewLoopForm
					projects={projects}
					agents={agents}
					origins={origins}
					onCreate={(ls) => {
						setLoops(ls);
						setCreating(false);
					}}
					onCancel={() => setCreating(false)}
				/>
			)}

			{loops.length === 0 && !creating && <div className="empty">No loops. Create one.</div>}

			{loops.map((l) => (
				<div key={l.id} className={`loop-card ${l.enabled ? "" : "off"}`}>
					<div className="loop-main">
						<div className="loop-title">
							<span>{l.title}</span>
							<span className="loop-tag">{envLabel(origins, l.id)}</span>
							<span className="loop-cadence muted">
								{l.agentId ?? "claude"} · {everyLabel(l.intervalMs)}
							</span>
						</div>
						{l.prompt && <div className="loop-desc muted">{l.prompt}</div>}
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
						<button
							type="button"
							className="loop-del"
							title="Delete this loop"
							onClick={() => void remove(l)}
						>
							<Trash2 size={14} />
						</button>
					</div>
				</div>
			))}
		</div>
	);
}
