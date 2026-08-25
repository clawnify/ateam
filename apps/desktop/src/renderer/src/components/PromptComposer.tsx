import type { AgentDTO } from "@ateam/protocol";
import { ArrowUp, Paperclip, X, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import type { HostStatus } from "../../../shared/host";
import { AgentPicker } from "./AgentPicker";
import { type EnvOption, EnvironmentPicker } from "./EnvironmentPicker";

/** Last path segment, for a compact chip label. */
function baseName(p: string): string {
	return p.split(/[/\\]/).pop() || p;
}

/** Mirror of git-core's slugify, for the live branch-name preview. */
function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
}

/** Readable task name derived from the prompt's first words. */
function titleFromPrompt(p: string): string {
	return p.trim().split(/\s+/).slice(0, 6).join(" ").slice(0, 60);
}

/**
 * Prompt-first agent launch, in two variants over the same form.
 *
 *   "task"    creates a branch + worktree and launches there: name is optional
 *             (the live branch preview shows what you'll get) and you choose
 *             which machine runs it.
 *   "session" opens another agent session inside a task that already exists —
 *             same prompt, agent, attachments and YOLO, but no name and no
 *             branch (it reuses the worktree), and no environment to pick
 *             because the task already lives on one.
 *
 * Either way the prompt is handed to the chosen agent as its first instruction,
 * and YOLO launches it permission-free.
 */
export function PromptComposer({
	agents,
	variant = "task",
	sessionAlias,
	defaultAgentId,
	environments = [],
	envAgents,
	onAdd,
	onInstall,
	onInstallAgent,
	onClose,
	onCreate,
}: {
	agents: AgentDTO[];
	/** "task" creates a branch + worktree; "session" launches into one that exists. */
	variant?: "task" | "session";
	/** Session variant: the engine the task already runs on — not a choice here. */
	sessionAlias?: string | null;
	/** Preselect this agent (a task's existing agent) instead of the first available. */
	defaultAgentId?: string;
	/** Where the task can run: this Mac + each ~/.ssh/config box. `alias` null = Local.
	 *  A box is disabled when the repo can't run there (no GitHub identity to clone).
	 *  Unused by the session variant, which has no environment to choose. */
	environments?: EnvOption[];
	/** Agent ids each connected engine actually has, keyed by alias ("local" for this
	 *  Mac). Lets the agent picker offer only what the chosen environment can run. */
	envAgents: Record<string, string[]>;
	/** Connect a Tailscale endpoint typed into the picker. */
	onAdd?: (endpoint: string) => Promise<void>;
	/** Set up a fresh box over SSH (install engine + connect) from the picker. */
	onInstall?: (dest: string, onLog: (chunk: string) => void) => Promise<HostStatus>;
	/** Install a coding agent's CLI on the selected box, streamed; returns the login step. */
	onInstallAgent?: (
		alias: string,
		agentId: string,
		onLog: (chunk: string) => void,
	) => Promise<{ loginCommand?: string }>;
	onClose: () => void;
	onCreate: (input: {
		name: string;
		prompt: string;
		agentId: string;
		yolo: boolean;
		files: string[];
		alias: string | null;
	}) => void;
}) {
	const [name, setName] = useState("");
	const [prompt, setPrompt] = useState("");
	const session = variant === "session";
	const [agentId, setAgentId] = useState(
		defaultAgentId ?? agents.find((a) => a.available)?.id ?? "claude",
	);
	const [yolo, setYolo] = useState(false);
	const [files, setFiles] = useState<string[]>([]);
	const [dragging, setDragging] = useState(false);
	// Remember the last-picked environment across tasks (and app restarts) so it isn't
	// re-selected every time; fall back to the first runnable one (Local, unless the repo
	// isn't here) when nothing valid is saved for this project. "__local__" = the Mac.
	const [alias, setAliasState] = useState<string | null>(() => {
		// A session runs where its task already is; only a new task gets a choice.
		if (session) return sessionAlias ?? null;
		const saved = localStorage.getItem("ateam.runOn");
		const savedAlias = saved === "__local__" ? null : saved;
		const usable =
			saved !== null && environments.some((e) => e.alias === savedAlias && !e.disabled);
		return usable ? savedAlias : (environments.find((e) => !e.disabled)?.alias ?? null);
	});
	const setAlias = (a: string | null) => {
		setAliasState(a);
		localStorage.setItem("ateam.runOn", a === null ? "__local__" : a);
	};

	// Which agents the chosen environment actually has installed. Known only for a
	// connected engine; when unknown, fall back to the catalog's own `available` flag.
	const availOnEnv = envAgents[alias ?? "local"];
	const isAvail = (id: string) => {
		const a = agents.find((x) => x.id === id);
		return availOnEnv ? availOnEnv.includes(id) : (a?.available ?? false);
	};

	// Switching environment can strand the picked agent (not installed there) — drop
	// to the first agent the new environment can actually run.
	useEffect(() => {
		if (!availOnEnv || availOnEnv.includes(agentId)) return;
		const first = agents.find((a) => availOnEnv.includes(a.id));
		if (first) setAgentId(first.id);
	}, [availOnEnv, agentId, agents]);

	const branch = slugify(name.trim() || titleFromPrompt(prompt));
	// A session has no name to fall back on — it needs something to say.
	const canSubmit = Boolean(
		session ? prompt.trim() || files.length : name.trim() || prompt.trim() || files.length,
	);

	// De-duped append, preserving order — the picker and drops both feed here.
	const addFiles = (paths: string[]) =>
		setFiles((cur) => [...cur, ...paths.filter((p) => p && !cur.includes(p))]);
	const removeFile = (path: string) => setFiles((cur) => cur.filter((p) => p !== path));

	const pickFiles = async () => {
		addFiles(await window.ateam.utils.pickFiles());
	};

	const onDrop = (e: React.DragEvent) => {
		e.preventDefault();
		setDragging(false);
		addFiles(Array.from(e.dataTransfer.files).map((f) => window.ateam.utils.pathForFile(f)));
	};

	const submit = () => {
		if (!canSubmit) return;
		const finalName =
			name.trim() || titleFromPrompt(prompt) || `task ${new Date().toISOString().slice(0, 10)}`;
		onCreate({ name: finalName, prompt: prompt.trim(), agentId, yolo, files, alias });
	};

	const onKeys = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			submit();
		}
		if (e.key === "Escape") onClose();
	};

	return (
		<div className="overlay" onMouseDown={onClose}>
			<div
				className={`dialog composer ${dragging ? "dropping" : ""}`}
				onMouseDown={(e) => e.stopPropagation()}
				onKeyDown={onKeys}
				onDragOver={(e) => {
					e.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={onDrop}
			>
				{!session && (
					<div className="comp-head">
						<input
							className="comp-name"
							placeholder="Task name (optional)"
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
						<span className="branch-preview" title="Branch name">
							{branch || "branch name"}
						</span>
					</div>
				)}
				{/* biome-ignore lint/a11y/noAutofocus: composer should focus its prompt */}
				<textarea
					autoFocus
					className="comp-prompt"
					placeholder="What do you want to do?"
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
				/>
				{files.length > 0 && (
					<div className="comp-files">
						{files.map((f) => (
							<span key={f} className="file-chip" title={f}>
								<span className="fc-name">{baseName(f)}</span>
								<button
									type="button"
									className="fc-x"
									aria-label={`Remove ${baseName(f)}`}
									onClick={() => removeFile(f)}
								>
									<X size={12} strokeWidth={2.25} />
								</button>
							</span>
						))}
					</div>
				)}
				<div className="comp-foot">
					<button
						type="button"
						className="iconbtn comp-attach"
						title="Attach files — their paths are handed to the agent"
						aria-label="Attach files"
						onClick={pickFiles}
					>
						<Paperclip size={16} strokeWidth={1.75} />
					</button>
					<AgentPicker
						agents={agents}
						value={agentId}
						onChange={setAgentId}
						isAvailable={isAvail}
						alias={alias}
						onInstallAgent={onInstallAgent}
					/>
					{!session && (
						<EnvironmentPicker
							environments={environments}
							value={alias}
							onChange={setAlias}
							onAdd={onAdd}
							onInstall={onInstall}
						/>
					)}
					<button
						type="button"
						className={`iconbtn comp-yolo ${yolo ? "active" : ""}`}
						title="Auto mode"
						aria-label="Auto mode"
						onClick={() => setYolo((v) => !v)}
					>
						<Zap size={16} strokeWidth={1.75} />
					</button>
					<span className="spacer" />
					<span className="muted" style={{ fontSize: 11 }}>
						⌘⏎
					</span>
					<button
						type="button"
						className="comp-go"
						disabled={!canSubmit}
						title={
							session
								? "Launch another agent session in this task (⌘⏎)"
								: "Create task and launch the agent (⌘⏎)"
						}
						onClick={submit}
					>
						<ArrowUp size={15} strokeWidth={2.25} />
					</button>
				</div>
			</div>
		</div>
	);
}
