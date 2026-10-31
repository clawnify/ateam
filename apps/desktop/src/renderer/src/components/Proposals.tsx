// Tasks and loops a task's agent proposed (the propose_task and propose_loop
// board tools; see proposals.ts in the server). The dialog itself is the
// ordinary New task or New loop dialog, filled in: App opens it once per
// proposal while the proposing task is on screen. These are the two pieces
// around it: the strip on the task panel, to open a proposal again after
// clicking away or drop it, and the note the dialog opens with, saying who
// proposed it and why. Auto mode is only ever the agent's suggestion here: an
// agent reads untrusted text (web pages, issues, logs), so it never gets to
// switch off another agent's permission prompts. The dialog's toggle starts off.
import type { TaskDTO, TaskProposalDTO } from "@ateam/protocol";
import { Plus, Repeat, X, Zap } from "lucide-react";

const KIND = { task: "Proposed task", loop: "Proposed loop" } as const;

/** The board card's line for a task holding proposals: why it is in Needs You. */
export function proposalLabel(task: TaskDTO): string | null {
	const [first, ...rest] = task.proposals ?? [];
	if (!first) return null;
	const more = rest.length ? ` (+${rest.length} more)` : "";
	return `${first.kind === "loop" ? "Proposes a loop" : "Proposes a task"}: ${first.name}${more}`;
}

/** One row per pending proposal, above the task's terminal. */
export function ProposalStrip({
	proposals,
	onOpen,
	onDismiss,
}: {
	proposals: TaskProposalDTO[];
	onOpen: (id: string) => void;
	onDismiss: (id: string) => void;
}) {
	return (
		<section className="proposals" aria-label="Proposed by this task's agent">
			{proposals.map((p) => (
				<div className="proposal" key={p.id}>
					{p.kind === "loop" ? (
						<Repeat size={13} className="proposal-icon" />
					) : (
						<Plus size={13} className="proposal-icon" />
					)}
					<button
						type="button"
						className="proposal-open"
						title={p.reason ?? `Open the ${p.kind} the agent proposed`}
						onClick={() => onOpen(p.id)}
					>
						<span className="proposal-kind">{KIND[p.kind]}</span>
						<span className="proposal-name">{p.name}</span>
						{p.reason && <span className="proposal-reason">{p.reason}</span>}
					</button>
					<button type="button" className="navbtn" onClick={() => onOpen(p.id)}>
						Open
					</button>
					<button
						type="button"
						className="iconbtn question-dismiss"
						title="Dismiss: don't create it"
						aria-label={`Dismiss ${p.name}`}
						onClick={() => onDismiss(p.id)}
					>
						<X size={13} />
					</button>
				</div>
			))}
		</section>
	);
}

/** The top of a dialog opened from a proposal: whose it is, why, and a way to say no. */
export function ProposalNote({
	from,
	proposal,
	onDismiss,
}: {
	/** The proposing task's name. */
	from: string;
	proposal: TaskProposalDTO;
	onDismiss: () => void;
}) {
	return (
		<div className="proposal-note">
			<div className="proposal-note-head">
				<span>
					{KIND[proposal.kind]}, from the agent in <strong>{from}</strong>
				</span>
				<button
					type="button"
					className="navbtn"
					title="Don't create it. Closing the dialog keeps it for later."
					onClick={onDismiss}
				>
					Dismiss
				</button>
			</div>
			{proposal.reason && <p className="proposal-reason">{proposal.reason}</p>}
			{proposal.yolo && (
				<p className="proposal-auto">
					<Zap size={12} strokeWidth={1.75} />
					Suggests Auto mode. It stays off until you turn it on below.
				</p>
			)}
		</div>
	);
}
