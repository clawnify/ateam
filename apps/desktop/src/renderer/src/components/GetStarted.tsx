// The board's place while there is no project at all: a new install (after the
// theme choice in Welcome.tsx), or the last project removed. It covers what
// stands between the user and a first task (a project, a coding agent), one
// optional step, and what happens next. The optional step is the AI keys: what
// they turn on (Needs you sorting, calling the Lead) is otherwise found only by
// going looking, and their fields are Settings' own (KeyField), so the two can't
// drift. Other setup stays in Settings, behind one link to Boxes: a checklist of
// every feature here would drift from Settings as features change.
import type { AgentDTO } from "@ateam/protocol";
import { FolderPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { SessionIcon } from "./AgentIcon";
import { KeyField, useCredentials } from "./SettingsPanel";

const and = new Intl.ListFormat("en", { type: "conjunction" });
const or = new Intl.ListFormat("en", { type: "disjunction" });

export function GetStarted({
	agents,
	onAdd,
	onRecheckAgents,
	onOpenBoxes,
	onOpenAi,
}: {
	/** This Mac's agents; empty until the first list arrives (the registry always has some). */
	agents: AgentDTO[];
	onAdd: () => void;
	/** Re-read this Mac's agents, so one installed in a terminal meanwhile shows up. */
	onRecheckAgents: () => void;
	onOpenBoxes: () => void;
	/** Settings → AI: everything a key is used for, and the models. */
	onOpenAi: () => void;
}) {
	const [keyError, setKeyError] = useState<string | null>(null);
	const { credentials, saveKey } = useCredentials(setKeyError);
	// Back from the terminal is when an install would have happened.
	useEffect(() => {
		window.addEventListener("focus", onRecheckAgents);
		return () => window.removeEventListener("focus", onRecheckAgents);
	}, [onRecheckAgents]);

	const installed = agents.filter((a) => a.available);
	return (
		<section className="get-started" aria-labelledby="get-started-title">
			<h1 id="get-started-title">Get started</h1>
			<p className="get-started-lede">
				Hand tasks to coding agents and watch them work side by side.
			</p>
			<ol className="get-started-steps">
				<li>
					<span className="get-started-num" aria-hidden="true">
						1
					</span>
					<div className="get-started-step">
						<h2>Add a project</h2>
						<p>
							Pick a folder with a git repository. If it isn't one yet, Ateam offers to make it one.
						</p>
						<button type="button" className="primary get-started-add" onClick={onAdd}>
							<FolderPlus size={14} strokeWidth={1.75} aria-hidden="true" />
							Add project…
						</button>
					</div>
				</li>
				<li>
					<span className="get-started-num" aria-hidden="true">
						2
					</span>
					<div className="get-started-step">
						<h2>Coding agents</h2>
						{agents.length === 0 ? (
							<p>Checking this Mac…</p>
						) : installed.length > 0 ? (
							<p className="get-started-agents">
								<span className="get-started-glyphs" aria-hidden="true">
									{installed.map((a) => (
										<SessionIcon key={a.id} agentId={a.id} />
									))}
								</span>
								{and.format(installed.map((a) => a.label))} {installed.length > 1 ? "are" : "is"}{" "}
								installed on this Mac.
							</p>
						) : (
							<p>
								None found on this Mac. Once you add a project, New task can install{" "}
								{or.format(agents.map((a) => a.label))}.
							</p>
						)}
					</div>
				</li>
				<li>
					<span className="get-started-num" aria-hidden="true">
						3
					</span>
					<div className="get-started-step">
						<h2>
							AI features <span className="get-started-optional">Optional</span>
						</h2>
						<p>
							With an OpenRouter or OpenAI key, a small model reads each finished turn and moves the
							task to Needs you when its agent is waiting on you. An OpenAI key also lets you call
							the Lead by voice.
						</p>
						<div className="get-started-keys">
							<span>OpenRouter</span>
							<KeyField provider="openRouter" status={credentials} onSave={saveKey} />
							<span>OpenAI</span>
							<KeyField provider="openAi" status={credentials} onSave={saveKey} />
						</div>
						{keyError && <p className="get-started-error">{keyError}</p>}
						<p className="get-started-note">
							Your agent's last message and your reply go to that provider. Everything else a key
							does is in{" "}
							<button type="button" className="get-started-link" onClick={onOpenAi}>
								Settings › AI
							</button>
							.
						</p>
					</div>
				</li>
				<li>
					<span className="get-started-num" aria-hidden="true">
						4
					</span>
					<div className="get-started-step">
						<h2>Then start a task</h2>
						<p>
							Each task gets its own branch and worktree, so agents never touch each other's files
							or your checkout.
						</p>
					</div>
				</li>
			</ol>
			<p className="get-started-more">
				Run agents on another machine, or follow them from your iPhone:{" "}
				<button type="button" className="get-started-link" onClick={onOpenBoxes}>
					Settings › Boxes
				</button>
			</p>
		</section>
	);
}
