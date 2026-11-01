import type { AgentDTO, BoxWake } from "@ateam/protocol";
import { ArrowUp, Paperclip, Plus, X, Zap } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { HostStatus } from "../../../shared/host";
import { titleFromPrompt } from "../titleFromPrompt";
import { AgentPicker } from "./AgentPicker";
import { EnvironmentPicker, type EnvOption } from "./EnvironmentPicker";

/** Last path segment, for a compact chip label. */
function baseName(p: string): string {
	return p.split(/[/\\]/).pop() || p;
}

/** A file's bytes as base64, for writeImageBytes. */
function toBase64(f: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
		r.onerror = () => reject(r.error);
		r.readAsDataURL(f);
	});
}

/**
 * Prompt-first agent launch, in two variants over the same form.
 *
 *   "task"    creates a branch + worktree and launches there: name is optional
 *             (the branch is its slug, shown in the open task) and you choose
 *             which machine runs it.
 *   "session" opens another agent session inside a task that already exists —
 *             same prompt, agent, attachments and YOLO, but no name and no
 *             branch (it reuses the worktree), and no environment to pick
 *             because the task already lives on one.
 *
 * Either way the prompt is handed to the chosen agent as its first instruction,
 * and YOLO launches it permission-free.
 *
 * A task is created and opened (⌘⏎), or created and left in the background
 * (⇧⌘⏎, or ⇧-click) so the view you were on stays put.
 */
export function PromptComposer({
	agents,
	variant = "task",
	sessionAlias,
	defaultAgentId,
	initialName = "",
	initialPrompt = "",
	initialFiles = [],
	initialAlias,
	header,
	environments = [],
	envAgents,
	onAdd,
	onInstall,
	onForget,
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
	initialName?: string;
	initialPrompt?: string;
	/** Paths to start attached, e.g. files dropped on a project in the sidebar. */
	initialFiles?: string[];
	/** Start on this environment, when it can run the task, instead of the last
	 *  one picked; picking another is remembered as usual. */
	initialAlias?: string | null;
	/** Shown above the form, e.g. who proposed this task and why. */
	header?: ReactNode;
	/** Where the task can run: this Mac + each ~/.ssh/config box. `alias` null = Local.
	 *  A box is disabled when the repo can't run there (no GitHub identity to clone).
	 *  Unused by the session variant, which has no environment to choose. */
	environments?: EnvOption[];
	/** Agent ids each connected engine actually has, keyed by alias ("local" for this
	 *  Mac). Lets the agent picker offer only what the chosen environment can run. */
	envAgents: Record<string, string[]>;
	/** Connect a Tailscale endpoint typed into the picker, with the provider that wakes it. */
	onAdd?: (endpoint: string, wake: BoxWake | null) => Promise<void>;
	/** Set up a fresh box over SSH (install engine + connect) from the picker. */
	onInstall?: (dest: string, onLog: (chunk: string) => void) => Promise<HostStatus>;
	/** Remove a box from the picker's list (disconnecting it first if connected). */
	onForget?: (alias: string) => Promise<void>;
	/** Install a coding agent's CLI on the selected environment; returns the login step. */
	onInstallAgent?: (alias: string | null, agentId: string) => Promise<{ loginCommand?: string }>;
	onClose: () => void;
	onCreate: (input: {
		name: string;
		prompt: string;
		agentId: string;
		yolo: boolean;
		files: string[];
		alias: string | null;
		/** false: create it in the background and leave the view as it is (⇧⌘⏎).
		 *  A session always opens, being a tab of the task already on screen. */
		open: boolean;
	}) => void;
}) {
	const [name, setName] = useState(initialName);
	const [prompt, setPrompt] = useState(initialPrompt);
	const session = variant === "session";
	const [agentId, setAgentId] = useState(
		defaultAgentId ?? agents.find((a) => a.available)?.id ?? "claude",
	);
	const [yolo, setYolo] = useState(false);
	const [files, setFiles] = useState<string[]>(initialFiles);
	const [dragging, setDragging] = useState(false);
	// Files still being saved from their bytes, and a line about a drop that can't attach.
	const [pending, setPending] = useState(0);
	const [note, setNote] = useState<string | null>(null);
	// ⇧ together with ⌘ (or with the pointer on the go button) means "create and
	// stay", and the button says so before you commit. ⇧ alone is only a capital
	// letter being typed, so it leaves the button alone.
	const [mods, setMods] = useState({ shift: false, cmd: false });
	const [overGo, setOverGo] = useState(false);
	useEffect(() => {
		if (session) return;
		const track = (e: KeyboardEvent) => {
			const next = { shift: e.shiftKey, cmd: e.metaKey || e.ctrlKey };
			setMods((cur) => (cur.shift === next.shift && cur.cmd === next.cmd ? cur : next));
		};
		const reset = () => setMods({ shift: false, cmd: false });
		window.addEventListener("keydown", track);
		window.addEventListener("keyup", track);
		window.addEventListener("blur", reset);
		return () => {
			window.removeEventListener("keydown", track);
			window.removeEventListener("keyup", track);
			window.removeEventListener("blur", reset);
		};
	}, [session]);
	const staying = !session && mods.shift && (mods.cmd || overGo);
	// Remember the last-picked environment across tasks (and app restarts) so it isn't
	// re-selected every time; fall back to the first runnable one (Local, unless the repo
	// isn't here) when nothing valid is saved for this project. "__local__" = the Mac.
	const [alias, setAliasState] = useState<string | null>(() => {
		// A session runs where its task already is; only a new task gets a choice.
		if (session) return sessionAlias ?? null;
		if (
			initialAlias !== undefined &&
			environments.some((e) => e.alias === initialAlias && !e.disabled)
		)
			return initialAlias;
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

	// A session has no name to fall back on — it needs something to say.
	// A file still being saved isn't in `files` yet: a quick ⌘⏎ would start the agent without it.
	const canSubmit =
		pending === 0 &&
		Boolean(session ? prompt.trim() || files.length : name.trim() || prompt.trim() || files.length);

	// De-duped append, preserving order — the picker and drops both feed here.
	const addFiles = (paths: string[]) =>
		setFiles((cur) => [...cur, ...paths.filter((p) => p && !cur.includes(p))]);
	const removeFile = (path: string) => setFiles((cur) => cur.filter((p) => p !== path));
	// Chip labels for files saved from bytes: their temp path is a random name.
	const [labels, setLabels] = useState<Record<string, string>>({});

	const pickFiles = async () => {
		addFiles(await window.ateam.utils.pickFiles());
	};

	/** Files from a drop or a paste. Those on disk attach by their path; the rest
	 *  (a pasted screenshot, an image dragged out of a page) have no path, so their
	 *  bytes are saved to a temp file on this Mac and that path is attached. */
	const attach = async (list: File[]) => {
		setNote(null);
		const paths = list.map((f) => window.ateam.utils.pathForFile(f));
		addFiles(paths);
		const unsaved = list.filter((_, i) => !paths[i]);
		setPending((n) => n + unsaved.length);
		for (const f of unsaved) {
			try {
				const ext = /\.([a-z0-9]+)$/i.exec(f.name)?.[1] ?? f.type.split("/")[1] ?? "";
				const path = await window.ateam.utils.writeImageBytes(await toBase64(f), ext);
				setLabels((cur) => ({ ...cur, [path]: f.name || baseName(path) }));
				addFiles([path]);
			} catch (err) {
				console.warn("composer: could not attach", f.name, err);
			} finally {
				setPending((n) => n - 1);
			}
		}
	};

	// The whole backdrop takes the drop, not just the dialog: a file let go
	// anywhere in the window while the composer is open attaches.
	const dropProps = {
		onDragOver: (e: React.DragEvent) => {
			if (!e.dataTransfer.types.includes("Files")) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
			setDragging(true);
		},
		onDragLeave: (e: React.DragEvent) => {
			// Crossing onto a child is not leaving; leaving the window is (null).
			if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
		},
		onDrop: (e: React.DragEvent) => {
			setDragging(false);
			if (!e.dataTransfer.files.length) {
				// An image dragged out of a browser or Slack arrives as a link to it, never
				// the file: this Electron's Chromium (132) hands a page no image data from
				// another app's drag. Say what does work instead of doing nothing.
				if (/<img\b/i.test(e.dataTransfer.getData("text/html")))
					setNote("This app sent a link, not the image. Copy the image, then press ⌘V.");
				return;
			}
			e.preventDefault();
			void attach(Array.from(e.dataTransfer.files));
		},
	};

	// A copied screenshot or Finder file arrives as files with no text; text
	// pastes as text.
	const onPaste = (e: React.ClipboardEvent) => {
		const dt = e.clipboardData;
		if (dt.getData("text/plain") || dt.files.length === 0) return;
		e.preventDefault();
		void attach(Array.from(dt.files));
	};

	const submit = (open: boolean) => {
		if (!canSubmit) return;
		const finalName =
			name.trim() || titleFromPrompt(prompt) || `task ${new Date().toISOString().slice(0, 10)}`;
		onCreate({
			name: finalName,
			prompt: prompt.trim(),
			agentId,
			yolo,
			files,
			alias,
			open: session || open,
		});
	};

	const onKeys = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			submit(!e.shiftKey);
		}
		if (e.key === "Escape") onClose();
	};

	return (
		<div className="overlay" onMouseDown={onClose} {...dropProps}>
			<div
				className={`dialog composer ${dragging ? "dropping" : ""}`}
				onMouseDown={(e) => e.stopPropagation()}
				onKeyDown={onKeys}
				onPaste={onPaste}
			>
				{header}
				{!session && (
					<div className="comp-head">
						<input
							className="comp-name"
							placeholder="Task name (optional)"
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
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
								<span className="fc-name">{labels[f] ?? baseName(f)}</span>
								<button
									type="button"
									className="fc-x"
									aria-label={`Remove ${labels[f] ?? baseName(f)}`}
									onClick={() => removeFile(f)}
								>
									<X size={12} strokeWidth={2.25} />
								</button>
							</span>
						))}
					</div>
				)}
				{note && <output className="comp-note muted">{note}</output>}
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
							onForget={onForget}
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
						{session ? "⌘⏎" : "⌘⏎ open · ⇧⌘⏎ stay"}
					</span>
					<button
						type="button"
						className={`comp-go ${staying ? "stay" : ""}`}
						disabled={!canSubmit}
						title={
							session
								? "Launch another agent session in this task (⌘⏎)"
								: staying
									? "Create task and stay here (⇧⌘⏎)"
									: "Create task and open it (⌘⏎). Hold ⇧ to stay here."
						}
						aria-label={
							session ? "Launch session" : staying ? "Create task and stay here" : "Create task"
						}
						onMouseEnter={() => setOverGo(true)}
						onMouseLeave={() => setOverGo(false)}
						onClick={(e) => submit(!e.shiftKey)}
					>
						{staying ? (
							<Plus size={15} strokeWidth={2.25} />
						) : (
							<ArrowUp size={15} strokeWidth={2.25} />
						)}
					</button>
				</div>
			</div>
		</div>
	);
}
