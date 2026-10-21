import { SpellCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GrammarIssue } from "../grammar/filter";

/** How long a press on a correction must last to open its alternatives. */
const HOLD_MS = 400;

/**
 * One correction: a click applies Harper's first suggestion; holding it (or a
 * right-click) opens every suggestion above it to pick from instead.
 */
function Fix({ issue, onApply }: { issue: GrammarIssue; onApply: (result: string) => void }) {
	const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);
	const btnRef = useRef<HTMLButtonElement>(null);
	const popRef = useRef<HTMLDivElement>(null);
	const hold = useRef(0);
	// Set when a hold opened the list, so the click that ends the press doesn't apply.
	const held = useRef(false);

	useEffect(() => {
		if (!pos) return;
		const onDoc = (e: MouseEvent) => {
			const t = e.target as Node;
			if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
			setPos(null);
		};
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [pos]);

	useEffect(() => () => clearTimeout(hold.current), []);

	const first = issue.suggestions[0];
	if (!first) return null;

	const open = () => {
		const r = btnRef.current?.getBoundingClientRect();
		if (!r) return;
		held.current = true;
		// The toolbar sits at the bottom of the window, so the list opens upward.
		setPos({ bottom: window.innerHeight - r.top + 4, left: Math.max(8, r.left) });
	};

	return (
		<>
			<button
				type="button"
				ref={btnRef}
				className={`grammar-sugg ${pos ? "active" : ""}`}
				title={`Replace “${issue.problem}” with “${first.label}”. Hold for more`}
				// Keep focus in the terminal: the fix types into it.
				onMouseDown={(e) => e.preventDefault()}
				onPointerDown={(e) => {
					if (e.button !== 0) return;
					held.current = false;
					hold.current = window.setTimeout(open, HOLD_MS);
				}}
				onPointerUp={() => clearTimeout(hold.current)}
				onPointerLeave={() => clearTimeout(hold.current)}
				onContextMenu={(e) => {
					e.preventDefault();
					open();
				}}
				onClick={() => {
					if (held.current) return;
					onApply(first.result);
				}}
			>
				{first.label}
			</button>
			{pos &&
				createPortal(
					<div
						ref={popRef}
						className="menu-pop"
						style={{ position: "fixed", top: "auto", right: "auto", ...pos, zIndex: 1000 }}
					>
						{issue.suggestions.map((s) => (
							<button
								type="button"
								key={s.label}
								className="menu-item"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => {
									setPos(null);
									onApply(s.result);
								}}
							>
								{s.label}
							</button>
						))}
					</div>,
					document.body,
				)}
		</>
	);
}

/**
 * The terminal toolbar's grammar check of the prompt being typed: the first
 * correction for each problem, a click to apply. Applying hands the fixed
 * draft to `onApply`, which edits the agent's input. Renders nothing while
 * the draft is clean.
 */
export function GrammarFixes({
	issues,
	onApply,
}: {
	issues: GrammarIssue[];
	onApply: (result: string) => void;
}) {
	if (!issues.some((i) => i.suggestions.length)) return null;
	return (
		<span className="grammar-inline">
			<SpellCheck size={14} strokeWidth={1.75} aria-label="Grammar suggestions" />
			{issues.map((issue) => (
				<Fix key={`${issue.start}:${issue.end}`} issue={issue} onApply={onApply} />
			))}
		</span>
	);
}
