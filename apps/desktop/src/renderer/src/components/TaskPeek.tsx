import type { TaskDTO } from "@ateam/protocol";
import type { ReactElement, ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

/** How long the pointer rests on a task before its peek opens. Long on
 *  purpose: sweeping across the list must not pop a card on every row. */
const PEEK_DELAY_MS = 2000;

/**
 * Around one list of task peeks (the sidebar's rows, the board's cards). Once a
 * peek is open, the next task the pointer reaches opens at once instead of
 * waiting out the delay again, so reading down the list costs one wait.
 */
export function TaskPeekProvider({ children }: { children: ReactNode }) {
	return (
		<TooltipProvider delayDuration={PEEK_DELAY_MS} skipDelayDuration={400} disableHoverableContent>
			{children}
		</TooltipProvider>
	);
}

/**
 * A task's full title and where it stands (TaskDTO.summary), beside the row or
 * card the pointer rests on. Rows and cards cut the title short and carry no
 * summary, which otherwise only the open task shows. A task with no summary
 * yet peeks its title alone. Clicking closes it, and it stays closed until the
 * pointer leaves and comes back. Needs a TaskPeekProvider above it.
 */
export function TaskPeek({
	task,
	note,
	children,
}: {
	task: TaskDTO;
	/** A dimmer last line, such as why the row looks off. */
	note?: string;
	/** The row or card: one element that takes a ref. */
	children: ReactElement;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent
				side="right"
				align="start"
				sideOffset={8}
				className="max-w-80 px-2.5 py-2 text-pretty"
			>
				<div className="font-medium">{task.name}</div>
				{task.summary && <div className="mt-1 text-xs text-muted-foreground">{task.summary}</div>}
				{note && <div className="mt-1 text-xs text-muted-foreground">{note}</div>}
			</TooltipContent>
		</Tooltip>
	);
}
