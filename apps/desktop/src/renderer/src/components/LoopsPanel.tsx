import {
	type AgentDTO,
	boxSupports,
	dailyCron,
	dailyTimeOf,
	FEATURE_MIN_VERSION,
	type LoopDTO,
	loopScheduleLabel,
} from "@ateam/protocol";
import {
	AlertTriangle,
	ArrowUp,
	Check,
	CheckCircle2,
	Laptop,
	Pencil,
	Play,
	Plus,
	RefreshCw,
	Server,
	Trash2,
	X,
	Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type Alias, aliasLabel, type EngineMember } from "../unify";
import { AgentPicker } from "./AgentPicker";
import { EnvironmentPicker, type EnvOption } from "./EnvironmentPicker";
import { SCHEDULE_PRESETS, type ScheduleKind, SchedulePicker } from "./SchedulePicker";

/** "in 45s" / "in 2m" / "now", or "—" when no next run is scheduled. */
function untilLabel(nextRunAt: number | null, now: number): string {
	if (nextRunAt == null) return "—";
	const ms = nextRunAt - now;
	if (ms <= 0) return "now";
	const s = Math.round(ms / 1000);
	if (s < 60) return `in ${s}s`;
	if (s < 5400) return `in ${Math.round(s / 60)}m`;
	return `in ${Math.round(s / 3600)}h`;
}

/** "12s ago" / "3m ago" / "never". */
function agoLabel(lastRunAt: number | null, now: number): string {
	if (lastRunAt == null) return "never";
	const s = Math.round((now - lastRunAt) / 1000);
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	return `${Math.round(s / 3600)}h ago`;
}

/** This machine's zone: what "every day at 09:00" means for whoever sets it. */
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Which kind of schedule a loop has, for the picker: a preset, custom, or a calendar. */
function scheduleKindOf(loop: LoopDTO | undefined): ScheduleKind {
	if (loop?.cron) {
		return dailyTimeOf(loop.cron)
			? { kind: "daily" }
			: { kind: "other", label: loopScheduleLabel(loop, LOCAL_TZ) };
	}
	const min = loop?.intervalMs ? Math.round(loop.intervalMs / 60_000) : 60;
	return SCHEDULE_PRESETS.some((p) => p.minutes === min)
		? { kind: "preset", minutes: min }
		: { kind: "custom" };
}

/** The engine holding the copy of the repo this loop was created on. */
function memberFor(members: EngineMember[], projectId: string | null): EngineMember | null {
	if (!projectId) return null;
	return members.find((m) => m.projectId === projectId) ?? null;
}

/**
 * The loop dialog, for a scheduled agent session on an environment. With
 * `editing`, it patches that loop in place. The repo is the selected project, so
 * the only placement choice is WHICH environment runs it (this Mac or a box that
 * also has the repo); that's fixed at creation — moving a loop means delete +
 * recreate. Layout and controls mirror the New Task composer: name on top, the
 * prompt as the big field, and a foot of the same pills (agent, environment,
 * Auto mode) so the two dialogs read as one gesture.
 */
export function LoopForm({
	editing,
	members,
	agents,
	envProtocol,
	onInstallAgent,
	onSaved,
	onCancel,
}: {
	editing?: LoopDTO;
	members: EngineMember[];
	agents: AgentDTO[];
	envProtocol: Record<string, number>;
	onInstallAgent?: (alias: string | null, agentId: string) => Promise<{ loginCommand?: string }>;
	onSaved: () => void;
	onCancel: () => void;
}) {
	// Where the cursor lands when the form opens. A new loop cannot be created
	// without a name, so it starts there; an existing one already has its name,
	// so it opens on the prompt, like the composer. Keyed by the loop's id, not
	// by `editing` itself, so a re-render never yanks the cursor out of whatever
	// the user is typing.
	const nameRef = useRef<HTMLInputElement>(null);
	const promptRef = useRef<HTMLTextAreaElement>(null);
	const editingLoopId = editing?.id;
	useEffect(() => {
		(editingLoopId ? promptRef.current : nameRef.current)?.focus();
	}, [editingLoopId]);
	const [name, setName] = useState(editing?.title ?? "");
	const [prompt, setPrompt] = useState(editing?.prompt ?? "");
	const [followUp, setFollowUp] = useState(editing?.followUp ?? "");
	// Default environment: this Mac when it has the repo, else the first box.
	const [projectId, setProjectId] = useState(
		editing?.projectId ??
			members.find((m) => m.alias === null)?.projectId ??
			members[0]?.projectId ??
			"",
	);
	// Only agents actually installed on this machine can run a session.
	const usable = agents.filter((a) => a.available);
	const [agentId, setAgentId] = useState(editing?.agentId ?? usable[0]?.id ?? "claude");
	// A loop outlives the toolchain it was made with: the agent it is pinned to
	// can be uninstalled while the loop keeps ticking (every run then fails at
	// launch). The AgentPicker keeps the value and marks the pill "not installed"
	// rather than silently showing the first agent — Save would write the missing
	// one straight back, and this is the one screen you come to to repair the loop.
	const [schedule, setSchedule] = useState<ScheduleKind>(() => scheduleKindOf(editing));
	// The inputs beside the picker: minutes for Custom, a wall-clock time for daily.
	const [everyMin, setEveryMin] = useState(
		editing?.intervalMs ? String(Math.round(editing.intervalMs / 60_000)) : "60",
	);
	const [dailyAt, setDailyAt] = useState(dailyTimeOf(editing?.cron ?? null) ?? "09:00");
	const [yolo, setYolo] = useState(editing?.yolo ?? false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// The engine that will run this loop's sessions — the environment selected
	// (fixed at creation when editing). Both version-gated features key off it:
	// their config keys would be stored by an older box and silently ignored.
	const ownerAlias: Alias = memberFor(members, projectId)?.alias ?? null;
	const gatedBy = (feature: keyof typeof FEATURE_MIN_VERSION) => {
		if (!ownerAlias) return null;
		const version = envProtocol[ownerAlias];
		return version !== undefined && !boxSupports(feature, version) ? version : null;
	};
	// A follow-up is delivered by the OWNING engine's turn-end hook, so a box on
	// an older Ateam accepts the config key and then never acts on it. Gate on
	// that engine, like cleanup does: local is never skewed with itself.
	const followUpBlockedBy = gatedBy("followUps");
	// Same shape for Auto mode: an older engine stores the key and launches
	// permission-prompted, which wedges an unattended loop on its first ask.
	const autoBlockedBy = gatedBy("loopAutoMode");
	// And for calendars: an older engine drops `cron` on update and keeps the old
	// interval, so the save would look applied and not be.
	const scheduleBlockedBy = gatedBy("loopSchedules");

	// The schedule fields to send. A calendar keeps the zone it was set in (so
	// re-saving from another machine doesn't shift it); a new one takes this
	// machine's. "other" is a calendar this form can't edit: send nothing, keep it.
	const scheduleInput = (): { intervalMs?: number; cron?: string; timeZone?: string } => {
		if (schedule.kind === "preset") return { intervalMs: schedule.minutes * 60_000 };
		if (schedule.kind === "custom") return { intervalMs: Number(everyMin) * 60_000 };
		if (schedule.kind === "daily") {
			return { cron: dailyCron(dailyAt), timeZone: editing?.timeZone ?? LOCAL_TZ };
		}
		return {};
	};
	const scheduleReady =
		schedule.kind === "custom"
			? Number(everyMin) >= 1
			: schedule.kind === "daily"
				? /^\d{2}:\d{2}$/.test(dailyAt)
				: true;
	const ready = name.trim() && prompt.trim() && projectId && scheduleReady;

	const submit = async () => {
		if (!ready) return;
		setSaving(true);
		setError(null);
		try {
			if (editing) {
				await window.ateam.loops.update({
					id: editing.id,
					name: name.trim(),
					...scheduleInput(),
					config: {
						prompt: prompt.trim(),
						agentId,
						followUp: followUpBlockedBy === null ? followUp.trim() : "",
						yolo: autoBlockedBy === null ? yolo : false,
					},
				});
			} else {
				// The chosen environment is one engine's copy of this repo: that
				// engine owns the loop and runs every session there.
				await window.ateam.loops.create({
					templateId: "agent-session",
					name: name.trim(),
					projectId,
					...scheduleInput(),
					config: {
						prompt: prompt.trim(),
						agentId,
						followUp: followUpBlockedBy === null ? followUp.trim() : "",
						yolo: autoBlockedBy === null ? yolo : false,
					},
				});
			}
			onSaved();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};

	// The composer's gesture: ⌘⏎ submits, Escape backs out.
	const onKeys = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			void submit();
		}
		if (e.key === "Escape") onCancel();
	};

	// The EnvironmentPicker speaks aliases (null = this Mac); the loop's routing
	// key is the projectId on that engine. One maps onto the other 1:1 — members
	// are the engines holding this repo, one per alias.
	const envOptions: EnvOption[] = members.map((m) => ({
		alias: m.alias,
		label: aliasLabel(m.alias),
		disabled: false,
		// Surface a skewed box on the pill itself, like the composer does — the
		// feature gates below read off the same engine.
		skew: m.alias && envProtocol[m.alias] !== undefined ? envProtocol[m.alias] : undefined,
	}));
	const pickEnv = (alias: string | null) => {
		const member = members.find((m) => m.alias === alias);
		if (member) setProjectId(member.projectId);
	};

	return (
		<div className="overlay" role="presentation" onMouseDown={onCancel}>
			<div
				className="dialog composer loop-form"
				role="dialog"
				aria-modal="true"
				aria-label={editing ? "Edit loop" : "New loop"}
				onMouseDown={(e) => e.stopPropagation()}
				onKeyDown={onKeys}
			>
				<div className="loop-main">
					<div className="comp-head">
						<input
							ref={nameRef}
							className="comp-name"
							placeholder="Loop name"
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</div>
					<textarea
						ref={promptRef}
						className="comp-prompt"
						placeholder="What should each run do?"
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
					/>
					<div className="loop-followup">
						<span>
							{followUpBlockedBy === null
								? "Follow-up (optional) — sent once, after the agent's first reply"
								: `Follow-up — needs Ateam v${FEATURE_MIN_VERSION.followUps} on this box (it runs v${followUpBlockedBy})`}
						</span>
						<textarea
							className="comp-prompt"
							value={followUp}
							disabled={followUpBlockedBy !== null}
							placeholder="/check"
							onChange={(e) => setFollowUp(e.target.value)}
						/>
					</div>
					<div className="comp-foot">
						<AgentPicker
							agents={agents}
							value={agentId}
							onChange={setAgentId}
							isAvailable={(id) => agents.find((a) => a.id === id)?.available ?? false}
							alias={ownerAlias}
							onInstallAgent={onInstallAgent}
						/>
						{editing ? (
							<span
								className="comp-env-fixed"
								title="Fixed at creation — delete and recreate to move a loop"
							>
								{ownerAlias === null ? (
									<Laptop size={14} strokeWidth={1.75} />
								) : (
									<Server size={14} strokeWidth={1.75} />
								)}
								<span>{aliasLabel(ownerAlias)}</span>
							</span>
						) : (
							<EnvironmentPicker environments={envOptions} value={ownerAlias} onChange={pickEnv} />
						)}
						<SchedulePicker
							value={schedule}
							onChange={setSchedule}
							dailyBlockedReason={
								scheduleBlockedBy === null
									? null
									: `Needs Ateam v${FEATURE_MIN_VERSION.loopSchedules} on this box (it runs v${scheduleBlockedBy})`
							}
						/>
						{schedule.kind === "daily" && (
							<label className="comp-every" title={`Your time (${editing?.timeZone ?? LOCAL_TZ})`}>
								<input
									type="time"
									aria-label="Time of day"
									value={dailyAt}
									onChange={(e) => setDailyAt(e.target.value)}
								/>
							</label>
						)}
						{schedule.kind === "custom" && (
							<label className="comp-every" title="Minutes between runs">
								<input
									type="number"
									min={1}
									aria-label="Minutes between runs"
									value={everyMin}
									onChange={(e) => setEveryMin(e.target.value)}
								/>
								<span>min</span>
							</label>
						)}
						<button
							type="button"
							className={`iconbtn comp-yolo ${yolo ? "active" : ""}`}
							title={
								autoBlockedBy === null
									? "Auto mode — each run launches permission-free"
									: `Auto mode — needs Ateam v${FEATURE_MIN_VERSION.loopAutoMode} on this box (it runs v${autoBlockedBy})`
							}
							aria-label="Auto mode"
							disabled={autoBlockedBy !== null}
							onClick={() => setYolo((v) => !v)}
						>
							<Zap size={16} strokeWidth={1.75} />
						</button>
						<span className="spacer" />
						<button type="button" className="navbtn" onClick={onCancel}>
							<X size={14} /> Cancel
						</button>
						<span className="muted" style={{ fontSize: 11 }}>
							⌘⏎
						</span>
						<button
							type="button"
							className="comp-go"
							disabled={saving || !ready}
							title={editing ? "Save this loop (⌘⏎)" : "Create this loop (⌘⏎)"}
							onClick={() => void submit()}
						>
							{editing ? (
								<Check size={15} strokeWidth={2.25} />
							) : (
								<ArrowUp size={15} strokeWidth={2.25} />
							)}
						</button>
					</div>
					{error && (
						<div className="loop-stat err">
							<AlertTriangle size={13} /> {error}
						</div>
					)}
				</div>
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
	onChanged,
	onNew,
	onEdit,
}: {
	loops: LoopDTO[];
	members: EngineMember[];
	onChanged: () => void;
	/** Open the New loop dialog (App owns it, so the sidebar's "+" opens it too). */
	onNew: () => void;
	/** Open the edit dialog for this loop. */
	onEdit: (id: string) => void;
}) {
	const [busy, setBusy] = useState<string | null>(null);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const tick = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(tick);
	}, []);

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
					<button type="button" className="navbtn" onClick={onNew}>
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

			{loops.length === 0 && <div className="empty">No loops on this project. Create one.</div>}

			{loops.map((l) => (
				<div key={l.id} className={`loop-card ${l.enabled ? "" : "off"}`}>
					<div className="loop-main">
						<div className="loop-title">
							<span>{l.title}</span>
							<span className="loop-tag">
								{aliasLabel(memberFor(members, l.projectId)?.alias ?? null)}
							</span>
							<span className="loop-cadence muted">
								{l.agentId ?? "claude"} · {loopScheduleLabel(l, LOCAL_TZ)}
								{l.yolo && (
									<span className="loop-auto" title="Auto mode — each run launches permission-free">
										<Zap size={10} strokeWidth={2} />
									</span>
								)}
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
							onClick={() => onEdit(l.id)}
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
			))}
		</div>
	);
}
