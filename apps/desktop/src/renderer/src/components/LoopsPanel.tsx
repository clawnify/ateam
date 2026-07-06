import { AlertTriangle, CheckCircle2, Play, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { LoopDTO, LoopTemplateDTO, ProjectDTO } from "@ateam/protocol";

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

/** Inline form for instantiating a loop from a template. */
function NewLoopForm({
	templates,
	projects,
	onCreate,
	onCancel,
}: {
	templates: LoopTemplateDTO[];
	projects: ProjectDTO[];
	onCreate: (loops: LoopDTO[]) => void;
	onCancel: () => void;
}) {
	const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
	const [name, setName] = useState("");
	const [projectId, setProjectId] = useState("");
	const [everyMin, setEveryMin] = useState("");
	const [saving, setSaving] = useState(false);

	const template = templates.find((t) => t.id === templateId);

	const submit = async () => {
		if (!templateId) return;
		setSaving(true);
		try {
			const loops = await window.ateam.loops.create({
				templateId,
				name: name.trim() || (template?.title ?? "Loop"),
				projectId: projectId || undefined,
				intervalMs: everyMin ? Number(everyMin) * 60_000 : undefined,
			});
			onCreate(loops);
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="loop-card loop-form">
			<div className="loop-main">
				<div className="loop-form-row">
					<label>
						Template
						<select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
							{templates.map((t) => (
								<option key={t.id} value={t.id}>
									{t.title}
								</option>
							))}
						</select>
					</label>
					<label>
						Name
						<input
							value={name}
							placeholder={template?.title ?? ""}
							onChange={(e) => setName(e.target.value)}
						/>
					</label>
				</div>
				<div className="loop-form-row">
					<label>
						Project
						<select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
							<option value="">All projects</option>
							{projects.map((p) => (
								<option key={p.id} value={p.id}>
									{p.name}
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
							placeholder="self-paced"
							onChange={(e) => setEveryMin(e.target.value)}
						/>
					</label>
				</div>
				{template && <div className="loop-desc muted">{template.description}</div>}
			</div>
			<div className="loop-actions">
				<button type="button" className="navbtn" onClick={submit} disabled={saving || !templateId}>
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
 * The Loops panel: lists every loop (built-in reconcilers + user-defined
 * template instances) with last-run summary, next-run countdown, enable
 * toggle, run-now, and (for user loops) delete. A "New loop" form instantiates
 * a template. Stays live via the loops:updated push event and a 1s tick.
 */
export function LoopsPanel() {
	const [loops, setLoops] = useState<LoopDTO[]>([]);
	const [templates, setTemplates] = useState<LoopTemplateDTO[]>([]);
	const [projects, setProjects] = useState<ProjectDTO[]>([]);
	const [busy, setBusy] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		void window.ateam.loops.list().then(setLoops);
		void window.ateam.loops.templates().then(setTemplates);
		void window.ateam.projects.list().then(setProjects);
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
	const remove = async (l: LoopDTO) => {
		setLoops(await window.ateam.loops.remove(l.id));
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
						disabled={templates.length === 0}
					>
						<Plus size={14} /> New loop
					</button>
				</div>
				<p className="muted">
					Background reconcilers that keep the board honest. Built-ins run automatically; add your
					own from a template. Each runs on its own cadence — tight while work is active, relaxed
					when quiet.
				</p>
			</div>

			{creating && (
				<NewLoopForm
					templates={templates}
					projects={projects}
					onCreate={(ls) => {
						setLoops(ls);
						setCreating(false);
					}}
					onCancel={() => setCreating(false)}
				/>
			)}

			{loops.length === 0 && !creating && <div className="empty">No loops registered.</div>}

			{loops.map((l) => (
				<div key={l.id} className={`loop-card ${l.enabled ? "" : "off"}`}>
					<div className="loop-main">
						<div className="loop-title">
							<span>{l.title}</span>
							{l.kind === "user" && <span className="loop-tag">custom</span>}
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
						{l.kind === "user" && (
							<button
								type="button"
								className="loop-del"
								title="Delete this loop"
								onClick={() => void remove(l)}
							>
								<Trash2 size={14} />
							</button>
						)}
					</div>
				</div>
			))}
		</div>
	);
}
