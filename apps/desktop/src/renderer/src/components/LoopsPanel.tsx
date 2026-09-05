import { type AgentDTO, boxSupports, FEATURE_MIN_VERSION, type LoopDTO } from "@ateam/protocol";
import {
	AlertTriangle,
	Check,
	CheckCircle2,
	Pencil,
	Play,
	Plus,
	RefreshCw,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { type Alias, aliasLabel, type EngineMember } from "../unify";

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

/** The engine holding the copy of the repo this loop was created on. */
function memberFor(members: EngineMember[], projectId: string | null): EngineMember | null {
	if (!projectId) return null;
	return members.find((m) => m.projectId === projectId) ?? null;
}

// A half-written loop must survive a tab switch (the panel unmounts with the
// tab). Drafts live at module scope, keyed by the loop being edited (or
// "new:<card>" for the create form — a draft belongs to the repo it was started
// on), together with which form was open — restored on mount, cleared only on
// save or an explicit Cancel.
interface LoopDraft {
	name: string;
	prompt: string;
	followUp: string;
	projectId: string;
	agentId: string;
	everyMin: string;
}
const drafts = new Map<string, LoopDraft>();
const openForm = { creating: false, editingId: null as string | null };

/**
 * Inline form for a loop — a scheduled agent session on an environment. With
 * `editing`, it patches that loop in place. The repo is the selected project, so
 * the only placement choice is WHICH environment runs it (this Mac or a box that
 * also has the repo); that's fixed at creation — moving a loop means delete +
 * recreate.
 */
function LoopForm({
	editing,
	draftKey,
	members,
	agents,
	envProtocol,
	onSaved,
	onCancel,
}: {
	editing?: LoopDTO;
	draftKey: string;
	members: EngineMember[];
	agents: AgentDTO[];
	envProtocol: Record<string, number>;
	onSaved: () => void;
	onCancel: () => void;
}) {
	// Resume the surviving draft for this form, falling back to the loop being
	// edited (or blank for a new one). Every change is mirrored back into the
	// draft so a tab switch loses nothing.
	const draft = drafts.get(draftKey);
	const [name, setName] = useState(draft?.name ?? editing?.title ?? "");
	const [prompt, setPrompt] = useState(draft?.prompt ?? editing?.prompt ?? "");
	const [followUp, setFollowUp] = useState(draft?.followUp ?? editing?.followUp ?? "");
	// Default environment: this Mac when it has the repo, else the first box.
	const [projectId, setProjectId] = useState(
		draft?.projectId ??
			editing?.projectId ??
			members.find((m) => m.alias === null)?.projectId ??
			members[0]?.projectId ??
			"",
	);
	// Only agents actually installed on this machine can run a session.
	const usable = agents.filter((a) => a.available);
	const [agentId, setAgentId] = useState(
		draft?.agentId ?? editing?.agentId ?? usable[0]?.id ?? "claude",
	);
	// A loop outlives the toolchain it was made with: the agent it is pinned to
	// can be uninstalled while the loop keeps ticking (every run then fails at
	// launch). Without its own option the <select> would show the FIRST agent
	// while the state still held the missing one, and Save would write the
	// missing one straight back — the one screen you come to to repair the loop
	// would be unable to. So list it, marked, and let it be switched away from.
	const options = usable.some((a) => a.id === agentId)
		? usable
		: [
				...usable,
				{
					id: agentId,
					label: `${agents.find((a) => a.id === agentId)?.label ?? agentId} (not installed)`,
				},
			];
	const [everyMin, setEveryMin] = useState(
		draft?.everyMin ??
			(editing?.intervalMs ? String(Math.round(editing.intervalMs / 60_000)) : "60"),
	);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		drafts.set(draftKey, { name, prompt, followUp, projectId, agentId, everyMin });
	}, [draftKey, name, prompt, followUp, projectId, agentId, everyMin]);

	const close = (done: () => void) => {
		drafts.delete(draftKey);
		done();
	};

	// A follow-up is delivered by the OWNING engine's turn-end hook, so a box on
	// an older Ateam accepts the config key and then never acts on it. Gate on
	// that engine, like cleanup does: local is never skewed with itself.
	const followUpBlockedBy = (() => {
		const alias: Alias = memberFor(members, projectId)?.alias ?? null;
		if (!alias) return null;
		const version = envProtocol[alias];
		return version !== undefined && !boxSupports("followUps", version) ? version : null;
	})();

	const ready = prompt.trim() && projectId && Number(everyMin) >= 1;

	const submit = async () => {
		if (!ready) return;
		setSaving(true);
		setError(null);
		try {
			if (editing) {
				await window.ateam.loops.update({
					id: editing.id,
					name: name.trim() || "Loop",
					intervalMs: Number(everyMin) * 60_000,
					config: {
						prompt: prompt.trim(),
						agentId,
						followUp: followUpBlockedBy === null ? followUp.trim() : "",
					},
				});
			} else {
				// The chosen environment is one engine's copy of this repo: that
				// engine owns the loop and runs every session there.
				await window.ateam.loops.create({
					templateId: "agent-session",
					name: name.trim() || "Loop",
					projectId,
					intervalMs: Number(everyMin) * 60_000,
					config: {
						prompt: prompt.trim(),
						agentId,
						followUp: followUpBlockedBy === null ? followUp.trim() : "",
					},
				});
			}
			close(onSaved);
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
							{options.map((a) => (
								<option key={a.id} value={a.id}>
									{a.label}
								</option>
							))}
						</select>
					</label>
				</div>
				<div className="loop-form-row">
					<label>
						Environment
						<select
							value={projectId}
							disabled={!!editing}
							title={
								editing
									? "Fixed at creation — delete and recreate to move a loop"
									: "Which machine runs this loop's sessions"
							}
							onChange={(e) => setProjectId(e.target.value)}
						>
							{members.map((m) => (
								<option key={m.projectId} value={m.projectId}>
									{aliasLabel(m.alias)}
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
				<div className="loop-form-row">
					<label>
						{followUpBlockedBy === null
							? "Follow-up (optional) — sent once, after the agent's first reply"
							: `Follow-up — needs Ateam v${FEATURE_MIN_VERSION.followUps} on this box (it runs v${followUpBlockedBy})`}
						<textarea
							value={followUp}
							disabled={followUpBlockedBy !== null}
							placeholder="/check"
							onChange={(e) => setFollowUp(e.target.value)}
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
					{editing ? <Check size={14} /> : <Plus size={14} />}
					{editing ? "Save" : "Create"}
				</button>
				<button type="button" className="navbtn" onClick={() => close(onCancel)}>
					<X size={14} /> Cancel
				</button>
			</div>
		</div>
	);
}

/**
 * The Loops panel, scoped to the selected project. A loop is deliberately
 * user-created and nothing else: on its interval it starts the chosen coding
 * agent in a fresh task with the same prompt, on the environment (this Mac or a
 * box) it was created on. `loops` and `members` are the selected repo card's —
 * one card spans every engine holding that repo, so both engines' loops show
 * here and the only placement choice is which of them runs a new one.
 */
export function LoopsPanel({
	loops,
	members,
	cardKey,
	agents,
	envProtocol,
	onChanged,
}: {
	loops: LoopDTO[];
	members: EngineMember[];
	cardKey: string | null;
	agents: AgentDTO[];
	envProtocol: Record<string, number>;
	onChanged: () => void;
}) {
	const [busy, setBusy] = useState<string | null>(null);
	// Which form is open survives a tab switch, like the draft itself.
	const [creating, setCreatingState] = useState(openForm.creating);
	const [editingId, setEditingIdState] = useState<string | null>(openForm.editingId);
	const setCreating = (v: boolean) => {
		openForm.creating = v;
		setCreatingState(v);
	};
	const setEditingId = (v: string | null) => {
		openForm.editingId = v;
		setEditingIdState(v);
	};
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const tick = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(tick);
	}, []);

	// A loop being edited that left this project's scope (project switched, or the
	// loop was deleted elsewhere) would leave its form behind; close it so the
	// panel always reflects the selected project.
	useEffect(() => {
		if (openForm.editingId && !loops.some((l) => l.id === openForm.editingId)) {
			openForm.editingId = null;
			setEditingIdState(null);
		}
	}, [loops]);

	const toggle = async (l: LoopDTO) => {
		await window.ateam.loops.setEnabled(l.id, !l.enabled);
		onChanged();
	};
	const runNow = async (l: LoopDTO) => {
		setBusy(l.id);
		try {
			await window.ateam.loops.runNow(l.id);
			onChanged();
		} finally {
			setBusy(null);
		}
	};
	const remove = async (l: LoopDTO) => {
		await window.ateam.loops.remove(l.id);
		onChanged();
	};

	if (members.length === 0) {
		return (
			<div className="loops">
				<div className="loops-head">
					<div className="loops-head-row">
						<h2>Loops</h2>
					</div>
				</div>
				<div className="empty">Select a project to see its loops.</div>
			</div>
		);
	}

	return (
		<div className="loops">
			<div className="loops-head">
				<div className="loops-head-row">
					<h2>Loops</h2>
					<button type="button" className="navbtn" onClick={() => setCreating(!creating)}>
						<Plus size={14} /> New loop
					</button>
				</div>
				<p className="muted">
					A loop starts a coding-agent session with the same prompt on a schedule. Each loop owns
					one task (branch + worktree); every run is a fresh session in it, on the environment you
					pick (this Mac or a box that has this repo). Loops only exist when you create them, and
					you only see the selected project's.
				</p>
			</div>

			{creating && (
				<LoopForm
					draftKey={`new:${cardKey ?? ""}`}
					members={members}
					agents={agents}
					envProtocol={envProtocol}
					onSaved={() => {
						onChanged();
						setCreating(false);
					}}
					onCancel={() => setCreating(false)}
				/>
			)}

			{loops.length === 0 && !creating && (
				<div className="empty">No loops on this project. Create one.</div>
			)}

			{loops.map((l) =>
				editingId === l.id ? (
					<LoopForm
						key={l.id}
						editing={l}
						draftKey={l.id}
						members={members}
						agents={agents}
						envProtocol={envProtocol}
						onSaved={() => {
							onChanged();
							setEditingId(null);
						}}
						onCancel={() => setEditingId(null)}
					/>
				) : (
					<div key={l.id} className={`loop-card ${l.enabled ? "" : "off"}`}>
						<div className="loop-main">
							<div className="loop-title">
								<span>{l.title}</span>
								<span className="loop-tag">
									{aliasLabel(memberFor(members, l.projectId)?.alias ?? null)}
								</span>
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
								className="loop-del loop-edit"
								title="Edit this loop"
								onClick={() => {
									setCreating(false);
									setEditingId(l.id);
								}}
							>
								<Pencil size={14} />
							</button>
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
				),
			)}
		</div>
	);
}
