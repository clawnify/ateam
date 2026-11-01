// The Lead composer's text box, where "@" points at a task (the rules are in
// lead-refs.ts). The list opens above the composer and is driven from the
// text box, so typing never leaves it: ↑/↓ move, Enter or Tab picks, Esc
// closes. A picked task is tinted in place by a layer behind the transparent
// textarea that lays out the same text with the same metrics (index.css).
import { relativeAge, type TaskDTO } from "@ateam/protocol";
import {
	type ClipboardEvent,
	type KeyboardEvent,
	type RefObject,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { type DraftRef, matchTasks, refQuery, splitDraft, tokenFor } from "../lead-refs";
import { AgentIcon } from "./AgentIcon";

export function TaskRefInput({
	value,
	onChange,
	refs,
	onRefsChange,
	tasks,
	projectName,
	inputRef,
	placeholder,
	label,
	onKeyDown,
	onPaste,
}: {
	value: string;
	onChange: (value: string) => void;
	/** The tasks picked into this draft. */
	refs: DraftRef[];
	onRefsChange: (refs: DraftRef[]) => void;
	tasks: TaskDTO[];
	projectName: (projectId: string) => string | undefined;
	inputRef: RefObject<HTMLTextAreaElement | null>;
	placeholder: string;
	label: string;
	/** Keys the list doesn't take (Enter to send). */
	onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
	onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
}) {
	// Where the caret sits, or null while text is selected (no list then).
	const [caret, setCaret] = useState<number | null>(null);
	const [focused, setFocused] = useState(false);
	// The "@" the user closed the list on with Esc: it stays closed until that one is gone.
	const [dismissed, setDismissed] = useState<number | null>(null);
	const [active, setActive] = useState(0);
	const listId = useId();
	const list = useRef<HTMLDivElement>(null);
	const marks = useRef<HTMLDivElement>(null);
	// Where the caret goes once a pick's new text has rendered.
	const caretAfter = useRef<number | null>(null);

	const trigger = caret == null ? null : refQuery(value, caret, refs);
	const start = trigger?.start ?? null;
	const query = trigger?.query ?? null;
	if (dismissed !== null && start === null) setDismissed(null);
	const matches = useMemo(
		() =>
			start === null || query === null || start === dismissed
				? []
				: matchTasks(tasks, query, projectName),
		[tasks, start, query, dismissed, projectName],
	);
	const open = focused && matches.length > 0;
	// A new query starts at the top of its list.
	const [listFor, setListFor] = useState(`${start}:${query}`);
	if (listFor !== `${start}:${query}`) {
		setListFor(`${start}:${query}`);
		setActive(0);
	}
	const cur = Math.min(active, matches.length - 1);

	useLayoutEffect(() => {
		const at = caretAfter.current;
		if (at === null) return;
		caretAfter.current = null;
		inputRef.current?.setSelectionRange(at, at);
	});
	// biome-ignore lint/correctness/useExhaustiveDependencies: cur is the trigger, not a value the body reads: the row it marks is found in the DOM.
	useEffect(() => {
		if (open)
			list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
	}, [open, cur]);

	const track = (el: HTMLTextAreaElement) =>
		setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null);

	const pick = (task: TaskDTO) => {
		if (start === null || caret === null) return;
		const live = refs.filter((r) => value.includes(r.token));
		const token = tokenFor(task, live);
		const after = value.slice(caret);
		const next = `${value.slice(0, start)}${token}${after.startsWith(" ") ? "" : " "}${after}`;
		const at = start + token.length + 1;
		caretAfter.current = at;
		setCaret(at);
		onChange(next);
		onRefsChange([...live.filter((r) => r.token !== token), { token, taskId: task.id }]);
	};

	const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		const t = matches[cur];
		if (open && t && !e.nativeEvent.isComposing) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const n = matches.length;
				setActive((cur + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
				return;
			}
			if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
				e.preventDefault();
				pick(t);
				return;
			}
			if (e.key === "Escape") {
				// Only the list closes, not whatever holds the chat.
				e.preventDefault();
				e.stopPropagation();
				setDismissed(start);
				return;
			}
		}
		onKeyDown(e);
	};

	const parts = refs.length ? splitDraft(value, refs) : [];
	let offset = 0;
	const now = Date.now();

	return (
		<>
			<div className="lead-input">
				{parts.some((p) => p.ref) && (
					<div className="lead-input-marks" ref={marks} aria-hidden>
						{parts.map((p) => {
							const at = offset;
							offset += p.text.length;
							return p.ref ? <mark key={at}>{p.text}</mark> : p.text;
						})}
					</div>
				)}
				<textarea
					ref={inputRef}
					value={value}
					rows={1}
					placeholder={placeholder}
					aria-label={label}
					aria-autocomplete="list"
					aria-controls={open ? listId : undefined}
					aria-activedescendant={open ? `${listId}-${cur}` : undefined}
					onChange={(e) => {
						track(e.target);
						onChange(e.target.value);
					}}
					onSelect={(e) => track(e.currentTarget)}
					onFocus={(e) => {
						setFocused(true);
						track(e.currentTarget);
					}}
					onBlur={() => setFocused(false)}
					onScroll={(e) => {
						if (marks.current) marks.current.scrollTop = e.currentTarget.scrollTop;
					}}
					onKeyDown={keyDown}
					onPaste={onPaste}
				/>
			</div>
			{open && (
				<div className="lead-refs">
					<div className="lead-refs-title">Tasks</div>
					<div className="lead-refs-list" role="listbox" id={listId} aria-label="Tasks" ref={list}>
						{matches.map((t, i) => (
							// biome-ignore lint/a11y/useKeyWithClickEvents: the keys are the text box's (aria-activedescendant), which keeps focus while the list is open
							<div
								key={t.id}
								id={`${listId}-${i}`}
								role="option"
								tabIndex={-1}
								aria-selected={i === cur}
								className={i === cur ? "lead-ref active" : "lead-ref"}
								// Keep the caret in the text box through the click.
								onMouseDown={(e) => e.preventDefault()}
								onMouseMove={() => i !== cur && setActive(i)}
								onClick={() => pick(t)}
							>
								<AgentIcon agentId={t.agentId} size={12} />
								<span className="lead-ref-name">{t.name}</span>
								<span className="lead-ref-meta">
									{[projectName(t.projectId), relativeAge(t.lastEventAt, now)]
										.filter(Boolean)
										.join(" · ")}
								</span>
							</div>
						))}
					</div>
				</div>
			)}
		</>
	);
}
