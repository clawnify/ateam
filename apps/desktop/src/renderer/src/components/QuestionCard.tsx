// A question a task's agent asked the user (the ask_user board tool), answered
// here instead of in its terminal. The agent shapes the decision, not just the
// wording: options can carry what they mean, their tradeoffs, a risk and the
// agent's pick (shown as cards), a list of things to act on is a checklist
// with the safe rows pre-ticked, and the question itself is markdown whose
// ```mermaid blocks are drawn as diagrams. The answer reaches the agent as a
// message from the user (see questions.ts in the server). Shown in the Lead chat
// and on the task panel.
import type { QuestionChoiceDTO, TaskDTO } from "@ateam/protocol";
import { CircleHelp, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { AgentIcon } from "./AgentIcon";
import { Markdown } from "./Markdown";
import { PageFrame } from "./PageFrame";

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

function Risk({ risk }: { risk: QuestionChoiceDTO["risk"] }) {
	return risk ? <span className={`risk ${risk}`}>{risk} risk</span> : null;
}

/** One option as a card: the tradeoffs are the point, the click is the answer. */
function ChoiceCard({
	choice,
	disabled,
	onPick,
}: {
	choice: QuestionChoiceDTO;
	disabled: boolean;
	onPick: () => void;
}) {
	return (
		<button
			type="button"
			className={`choice${choice.recommended ? " recommended" : ""}`}
			disabled={disabled}
			onClick={onPick}
		>
			<span className="choice-head">
				<span className="choice-label">{choice.label}</span>
				{choice.recommended && <span className="badge">Recommended</span>}
				<Risk risk={choice.risk} />
			</span>
			{choice.description && <span className="choice-desc">{choice.description}</span>}
			{(choice.pros?.length || choice.cons?.length) && (
				<span className="choice-tradeoffs">
					{choice.pros?.map((p) => (
						<span key={`+${p}`} className="pro">
							+ {p}
						</span>
					))}
					{choice.cons?.map((c) => (
						<span key={`-${c}`} className="con">
							− {c}
						</span>
					))}
				</span>
			)}
		</button>
	);
}

/** A list to act on: the agent pre-ticks the safe rows, the user unticks what to keep. */
function Checklist({
	choices,
	disabled,
	onSend,
}: {
	choices: QuestionChoiceDTO[];
	disabled: boolean;
	onSend: (ticked: string[]) => void;
}) {
	const [ticked, setTicked] = useState(
		() => new Set(choices.filter((c) => c.checked).map((c) => c.label)),
	);
	const toggle = (label: string) =>
		setTicked((s) => {
			const next = new Set(s);
			if (!next.delete(label)) next.add(label);
			return next;
		});
	return (
		<div className="checklist">
			{/* Scrolls when the list is long, so Send stays in view. */}
			<div className="check-rows">
				{choices.map((c) => (
					<label key={c.label} className="check-row">
						<input
							type="checkbox"
							checked={ticked.has(c.label)}
							disabled={disabled}
							onChange={() => toggle(c.label)}
						/>
						<span className="check-body">
							<span className="choice-head">
								<span className="choice-label">{c.label}</span>
								<Risk risk={c.risk} />
							</span>
							{c.description && <span className="choice-desc">{c.description}</span>}
						</span>
					</label>
				))}
			</div>
			<div className="checklist-foot">
				<button
					type="button"
					className="primary"
					disabled={disabled}
					// In the agent's order, not the order they were clicked.
					onClick={() => onSend(choices.map((c) => c.label).filter((l) => ticked.has(l)))}
				>
					{ticked.size === 0 ? "Send: none ticked" : `Send ${ticked.size} ticked`}
				</button>
			</div>
		</div>
	);
}

export function QuestionCard({
	task,
	onOpenTask,
	onAnswer = (input) => window.ateam.tasks.answerQuestion(input),
}: {
	task: TaskDTO;
	/** Show the task as a chip that opens it (the Lead's list); omit on the task's own panel. */
	onOpenTask?: (t: TaskDTO) => void;
	/** How the answer is sent. The Lead routes it through main, which also shows
	 *  it in the thread and follows the task for its reply; default: straight to the engine. */
	onAnswer?: (input: {
		taskId: string;
		questionId: string;
		answer: string | string[] | null;
	}) => Promise<unknown>;
}) {
	const q = task.question;
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!q) return null;

	const answer = async (value: string | string[] | null) => {
		setSending(true);
		setError(null);
		try {
			await onAnswer({ taskId: task.id, questionId: q.id, answer: value });
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
				{q.kind === "permission" && <span className="question-kind">permission</span>}
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
			{/* The part that scrolls when the card is short of room: the options
			    and the reply box below it always stay in view. */}
			<div className="question-body">
				<div className="md question-text">
					<Markdown text={q.text} />
				</div>
				{q.pageId && task.page?.id === q.pageId && (
					<PageFrame
						taskId={task.id}
						pageId={q.pageId}
						title={task.page.title}
						onAnswer={(v) => !sending && void answer(v)}
					/>
				)}
			</div>
			{q.select === "many" && q.choices ? (
				// Keyed by question: the card stays mounted when the next question
				// replaces this one (an AskUserQuestion call's next card, an ask_user
				// re-ask), and the ticks must not carry over.
				<Checklist
					key={q.id}
					choices={q.choices}
					disabled={sending}
					onSend={(t) => void answer(t)}
				/>
			) : q.choices ? (
				<div className="choices">
					{q.choices.map((c) => (
						<ChoiceCard
							key={c.label}
							choice={c}
							disabled={sending}
							onPick={() => void answer(c.label)}
						/>
					))}
				</div>
			) : (
				q.options.length > 0 && (
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
				)
			)}
			{q.allowText && q.select !== "many" && (
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
