// The box an answer is typed into on a card (a task's thread in the Lead chat,
// a question): it behaves like the Lead's composer. Enter sends (it submits its
// form), Shift+Enter starts a new line, and the box grows with the text.
import type { ComponentProps } from "react";

export function ReplyField({
	onEscape,
	onKeyDown,
	...props
}: ComponentProps<"textarea"> & {
	/** Esc, to close the box. */
	onEscape?: () => void;
}) {
	return (
		<textarea
			rows={1}
			{...props}
			onKeyDown={(e) => {
				onKeyDown?.(e);
				if (e.defaultPrevented || e.nativeEvent.isComposing) return;
				if (e.key === "Enter" && !e.shiftKey) {
					e.preventDefault();
					e.currentTarget.form?.requestSubmit();
				} else if (e.key === "Escape" && onEscape) onEscape();
			}}
		/>
	);
}
