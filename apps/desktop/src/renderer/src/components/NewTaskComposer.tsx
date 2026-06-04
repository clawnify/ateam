import { ArrowUp, Zap } from "lucide-react";
import { useState } from "react";
import type { AgentDTO } from "../../../shared/types";

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
 * Prompt-first task creation: name is optional (live branch preview shows
 * what you'll get), the prompt is handed to the chosen agent as its first
 * instruction, and YOLO launches it permission-free.
 */
export function NewTaskComposer({
	agents,
	onClose,
	onCreate,
}: {
	agents: AgentDTO[];
	onClose: () => void;
	onCreate: (input: {
		name: string;
		prompt: string;
		agentId: string;
		yolo: boolean;
	}) => void;
}) {
	const [name, setName] = useState("");
	const [prompt, setPrompt] = useState("");
	const [agentId, setAgentId] = useState(
		agents.find((a) => a.available)?.id ?? "claude",
	);
	const [yolo, setYolo] = useState(false);

	const branch = slugify(name.trim() || titleFromPrompt(prompt));
	const canSubmit = Boolean(name.trim() || prompt.trim());

	const submit = () => {
		if (!canSubmit) return;
		const finalName =
			name.trim() ||
			titleFromPrompt(prompt) ||
			`task ${new Date().toISOString().slice(0, 10)}`;
		onCreate({ name: finalName, prompt: prompt.trim(), agentId, yolo });
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
				className="dialog composer"
				onMouseDown={(e) => e.stopPropagation()}
				onKeyDown={onKeys}
			>
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
				{/* biome-ignore lint/a11y/noAutofocus: composer should focus its prompt */}
				<textarea
					autoFocus
					className="comp-prompt"
					placeholder="What do you want to do?"
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
				/>
				<div className="comp-foot">
					<select
						className="agent-select"
						value={agentId}
						onChange={(e) => setAgentId(e.target.value)}
					>
						{agents.map((a) => (
							<option key={a.id} value={a.id} disabled={!a.available}>
								{a.label}
								{a.available ? "" : " (not installed)"}
							</option>
						))}
					</select>
					<button
						type="button"
						className={`iconbtn comp-yolo ${yolo ? "active" : ""}`}
						title="YOLO mode — bypass all permissions"
						aria-label="YOLO mode"
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
						title="Create task and launch the agent (⌘⏎)"
						onClick={submit}
					>
						<ArrowUp size={15} strokeWidth={2.25} />
					</button>
				</div>
			</div>
		</div>
	);
}
