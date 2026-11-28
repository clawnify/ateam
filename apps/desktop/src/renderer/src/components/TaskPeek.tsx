import { type Alias, type TaskDTO, tagsFor } from "@ateam/protocol";
import { Monitor, Server } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { useBoxName } from "../box-name";
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
 * Full title, summary, machine and tags for the hovered task.
 */
export function TaskPeek({
	task,
	machine,
	note,
	children,
}: {
	task: TaskDTO;
	machine: Alias;
	/** A dimmer last line, such as why the row looks off. */
	note?: string;
	/** The row or card: one element that takes a ref. */
	children: ReactElement;
}) {
	const tags = tagsFor(task);
	const box = useBoxName()(machine);
	const MachineIcon = machine === null ? Monitor : Server;
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
				<div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
					<MachineIcon size={12} strokeWidth={1.75} className="shrink-0" aria-hidden />
					{box}
				</div>
				{tags.length > 0 && (
					<div className="mt-1.5 flex flex-wrap gap-1">
						{tags.map((tag) => (
							<span className="pill" key={tag}>
								{tag}
							</span>
						))}
					</div>
				)}
				{note && <div className="mt-1 text-xs text-muted-foreground">{note}</div>}
			</TooltipContent>
		</Tooltip>
	);
}
