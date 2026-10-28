// A question a task's agent asked the user (the ask_user board tool), answered
// here instead of in its terminal: the options as buttons, a typed answer when
// the agent allows one. The answer reaches the agent as a message from the user
// (see questions.ts in the server). Shown in the Lead chat and on the task panel.
import type { TaskDTO } from "@ateam/protocol";
import { CircleHelp, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { AgentIcon } from "./AgentIcon";

/** An IPC rejection carries Electron's prefix before the engine's own words. */
const cleanError = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).replace(
		/^Error invoking remote method '[^']+': (Error: )?/,
		"",
	);

function ago(at: number): string {
	const mins = Math.round((Date.now() - at) / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export function QuestionCard({
	task,
	onOpenTask,
}: {
	task: TaskDTO;
	/** Show the task as a chip that opens it (the Lead's list); omit on the task's own panel. */
	onOpenTask?: (t: TaskDTO) => void;
}) {
	const q = task.question;
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!q) return null;

	const answer = async (value: string | null) => {
		setSending(true);
		setError(null);
		try {
			await window.ateam.tasks.answerQuestion({ taskId: task.id, questionId: q.id, answer: value });
			setText("");
		} catch (e) {
			const msg = cleanError(e);
			setError(
				/Unknown method/.test(msg) ? "Update Ateam on this task's box to answer from here." : msg,
			);
		} finally {
			setSending(false);
		}
	};
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (text.trim()) void answer(text);
	};

	return (
		<section className="question" aria-label={`Question from ${task.name}`}>
			<div className="question-head">
				<CircleHelp size={13} className="question-icon" />
				{onOpenTask ? (
					<button
						type="button"
						className="lead-chip"
						title={`Open ${task.name}`}
						onClick={() => onOpenTask(task)}
					>
						<AgentIcon agentId={task.agentId} size={12} />
						<span className="lead-chip-name">{task.name}</span>
					</button>
				) : (
					<span className="question-who">The agent is asking you</span>
				)}
				<span className="question-when">{ago(q.askedAt)}</span>
				<button
					type="button"
					className="iconbtn question-dismiss"
					title="Dismiss: answered somewhere else"
					aria-label="Dismiss question"
					disabled={sending}
					onClick={() => void answer(null)}
				>
					<X size={13} />
				</button>
			</div>
			<p className="question-text">{q.text}</p>
			{q.options.length > 0 && (
				<div className="question-options">
					{q.options.map((o, i) => (
						<button
							type="button"
							key={o}
							className={i === 0 ? "primary" : undefined}
							disabled={sending}
							onClick={() => void answer(o)}
						>
							{o}
						</button>
					))}
				</div>
			)}
			{q.allowText && (
				<form className="question-reply" onSubmit={submit}>
					<input
						value={text}
						placeholder={q.options.length ? "Or type an answer" : "Type your answer"}
						aria-label="Your answer"
						disabled={sending}
						onChange={(e) => setText(e.target.value)}
					/>
					<button type="submit" disabled={sending || !text.trim()}>
						Send
					</button>
				</form>
			)}
			{error && <p className="question-error">{error}</p>}
		</section>
	);
}
