import { SpellCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { GrammarIssue } from "../grammar/filter";
import { Button } from "./ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";

/** How long a press on a correction must last to open its alternatives. */
const HOLD_MS = 400;

/**
 * One correction: a click applies Harper's first suggestion; holding it (or a
 * right-click) opens every suggestion above it to pick from instead.
 */
function Fix({ issue, onApply }: { issue: GrammarIssue; onApply: (result: string) => void }) {
	const [open, setOpen] = useState(false);
	const hold = useRef(0);
	// Set when a hold opened the list, so the click that ends the press doesn't apply.
	const held = useRef(false);

	useEffect(() => () => clearTimeout(hold.current), []);

	const first = issue.suggestions[0];
	if (!first) return null;

	const show = () => {
		held.current = true;
		setOpen(true);
	};

	// The button is an anchor, not a PopoverTrigger: a click applies the fix, and only
	// a hold or a right-click opens the list.
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverAnchor asChild>
				<Button
					variant="ghost"
					size="xs"
					className="h-[18px] rounded-[4px] px-1.5 text-[11px] text-foreground select-none data-[open=true]:bg-accent"
					data-open={open}
					title={`Replace “${issue.problem}” with “${first.label}”. Hold for more`}
					// Keep focus in the terminal: the fix types into it.
					onMouseDown={(e) => e.preventDefault()}
					onPointerDown={(e) => {
						if (e.button !== 0) return;
						held.current = false;
						hold.current = window.setTimeout(show, HOLD_MS);
					}}
					onPointerUp={() => clearTimeout(hold.current)}
					onPointerLeave={() => clearTimeout(hold.current)}
					onContextMenu={(e) => {
						e.preventDefault();
						show();
					}}
					onClick={() => {
						if (held.current) return;
						onApply(first.result);
					}}
				>
					{first.label}
				</Button>
			</PopoverAnchor>
			{/* The toolbar sits at the bottom of the window, so the list opens upward. It
			    never takes focus, so typing carries on in the terminal while it's open. */}
			<PopoverContent
				side="top"
				align="start"
				collisionPadding={8}
				className="flex w-auto min-w-[120px] flex-col p-1"
				onOpenAutoFocus={(e) => e.preventDefault()}
				onCloseAutoFocus={(e) => e.preventDefault()}
			>
				{issue.suggestions.map((s) => (
					<Button
						key={s.label}
						variant="ghost"
						className="h-auto justify-start px-2 py-1.5 text-foreground"
						onMouseDown={(e) => e.preventDefault()}
						onClick={() => {
							setOpen(false);
							onApply(s.result);
						}}
					>
						{s.label}
					</Button>
				))}
			</PopoverContent>
		</Popover>
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
