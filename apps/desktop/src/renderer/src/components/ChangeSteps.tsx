import {
	CHANGE_STEPS_MIN_FILES,
	type ChangeStepsDTO,
	type DiffFileDTO,
	type DiffResultDTO,
} from "@ateam/protocol";
import { RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { ChangesList, FileRows } from "./Changes";
import { IconButton } from "./IconButton";

/** How often to ask again while steps are being written (a write takes 15-60s). */
const POLL_MS = 4_000;
const VIEW_KEY = "ateam.changesView";

type View = "steps" | "files";

function readView(): View {
	try {
		return localStorage.getItem(VIEW_KEY) === "files" ? "files" : "steps";
	} catch {
		return "steps";
	}
}

function saveView(view: View): void {
	try {
		localStorage.setItem(VIEW_KEY, view);
	} catch {
		/* the choice just isn't remembered */
	}
}

/**
 * The task panel's list of changes. A diff of CHANGE_STEPS_MIN_FILES or more can
 * also be read as steps: the steps someone would use to explain the change, the
 * agent's reason for each, and first, whatever the agent's account of the work
 * never mentions. The steps are an index into the diff, never a copy of it:
 * every file opens the same live file diff the flat list does. "All files" is
 * the flat list, unchanged; an engine too old to write steps gets only that.
 */
export function ChangesPane({
	taskId,
	diff,
	selected,
	onSelect,
	onRefresh,
}: {
	taskId: string;
	diff: DiffResultDTO | null;
	selected: string | null;
	onSelect: (path: string) => void;
	onRefresh: () => void;
}) {
	const big = (diff?.files.length ?? 0) >= CHANGE_STEPS_MIN_FILES;
	const [view, setView] = useState<View>(readView);
	const [steps, setSteps] = useState<ChangeStepsDTO | null>(null);
	const [unsupported, setUnsupported] = useState(false);

	// Another task's steps must never show under this one.
	// biome-ignore lint/correctness/useExhaustiveDependencies: taskId is the trigger, not a value the body reads.
	useEffect(() => {
		setSteps(null);
		setUnsupported(false);
	}, [taskId]);

	// Asked again whenever the diff is re-read (a refresh, another task): the
	// engine answers from its table when the diff is the same, and starts new
	// steps when it moved on. While they are written, ask again until done. The
	// steps already shown stay up meanwhile.
	useEffect(() => {
		if (!big || !diff) return;
		let alive = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const ask = () =>
			window.ateam.tasks.changeSteps(taskId).then(
				(answer) => {
					if (!alive) return;
					setSteps(answer);
					if (answer.working) timer = setTimeout(ask, POLL_MS);
				},
				// An engine from before steps answers "Unknown method".
				() => alive && setUnsupported(true),
			);
		void ask();
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [taskId, big, diff]);

	const offered =
		big && !unsupported && steps?.unavailable !== "agent" && steps?.unavailable !== "small";
	if (!offered)
		return (
			<ChangesList diff={diff} selected={selected} onSelect={onSelect} onRefresh={onRefresh} />
		);

	const pick = (next: View) => {
		setView(next);
		saveView(next);
	};
	return (
		<div className={`changes${view === "steps" ? " by-step" : ""}`}>
			<div className="changes-head">
				<div className="changes-switch">
					<button type="button" aria-pressed={view === "steps"} onClick={() => pick("steps")}>
						By step
					</button>
					<button type="button" aria-pressed={view === "files"} onClick={() => pick("files")}>
						All files
					</button>
				</div>
				<IconButton icon={RotateCw} label="Refresh changes" onClick={onRefresh} />
			</div>
			{view === "files" ? (
				<FileRows diff={diff} selected={selected} onSelect={onSelect} />
			) : (
				<StepRows steps={steps} diff={diff} selected={selected} onSelect={onSelect} />
			)}
		</div>
	);
}

function StepRows({
	steps,
	diff,
	selected,
	onSelect,
}: {
	steps: ChangeStepsDTO | null;
	diff: DiffResultDTO | null;
	selected: string | null;
	onSelect: (path: string) => void;
}) {
	const byPath = new Map((diff?.files ?? []).map((f) => [f.path, f]));
	const status = !steps
		? "Reading the change…"
		: steps.working
			? steps.steps
				? "Writing new steps for the latest changes…"
				: "Writing steps for this change, usually under a minute…"
			: steps.unavailable === "failed"
				? "Couldn't write steps for this change. They'll be tried again later; All files has every file."
				: steps.steps && !steps.current
					? "Written before the latest changes."
					: null;

	// Files in the diff now that no step or note covers: added since the steps
	// were written. Found by comparing paths, no model involved.
	const covered = new Set([
		...(steps?.steps ?? []).flatMap((s) => s.files.map((f) => f.path)),
		...(steps?.unexplained ?? []).map((u) => u.path),
	]);
	const uncovered = steps?.steps ? (diff?.files ?? []).filter((f) => !covered.has(f.path)) : [];

	return (
		<div className="steps">
			{status && <div className="steps-status">{status}</div>}
			{steps && steps.unexplained.length > 0 && (
				<section className="step unexplained">
					<div className="step-title">Not in the agent's report</div>
					{steps.unexplained.map((u) => (
						<StepFile
							key={u.path}
							path={u.path}
							note={u.note}
							file={byPath.get(u.path)}
							selected={selected === u.path}
							onSelect={onSelect}
						/>
					))}
				</section>
			)}
			{uncovered.length > 0 && (
				<section className="step unexplained">
					<div className="step-title">Not in any step yet</div>
					{uncovered.map((f) => (
						<StepFile
							key={f.path}
							path={f.path}
							note="Changed since the steps were written."
							file={f}
							selected={selected === f.path}
							onSelect={onSelect}
						/>
					))}
				</section>
			)}
			{steps?.steps?.map((s, i) => (
				<section className="step" key={`${i}-${s.title}`}>
					<div className="step-title">
						<span className="step-num">{i + 1}</span>
						{s.title}
					</div>
					{s.why && <p className="step-why">{s.why}</p>}
					{s.files.map((f) => (
						<StepFile
							key={f.path}
							path={f.path}
							note={f.note}
							file={byPath.get(f.path)}
							selected={selected === f.path}
							onSelect={onSelect}
						/>
					))}
				</section>
			))}
		</div>
	);
}

/** One file under a step: its name, counts and the note, opening its diff. */
function StepFile({
	path,
	note,
	file,
	selected,
	onSelect,
}: {
	path: string;
	note: string;
	/** The file in the live diff; absent once it no longer differs from base. */
	file: DiffFileDTO | undefined;
	selected: boolean;
	onSelect: (path: string) => void;
}) {
	const slash = path.lastIndexOf("/");
	return (
		<button
			type="button"
			className={`step-file${selected ? " selected" : ""}`}
			title={path}
			onClick={() => onSelect(path)}
		>
			<span className="step-file-head">
				<span className="fpath">
					{slash >= 0 && <span className="fdir">{path.slice(0, slash + 1)}</span>}
					{path.slice(slash + 1)}
				</span>
				{file ? (
					<span className="fstat">
						<span className="add">+{file.additions}</span>{" "}
						<span className="del">-{file.deletions}</span>
					</span>
				) : (
					<span className="fstat muted">no change now</span>
				)}
			</span>
			{note && <span className="step-note">{note}</span>}
		</button>
	);
}
