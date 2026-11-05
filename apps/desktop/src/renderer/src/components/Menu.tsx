import type { LucideIcon } from "lucide-react";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export interface MenuItem {
	label: string;
	icon?: LucideIcon;
	onClick: () => void;
	danger?: boolean;
	disabled?: boolean;
	/** Ask for a second click right where the first one landed, instead of a
	 *  dialog across the window: the first click keeps the menu open and
	 *  swaps the label for this text, and only the second runs `onClick`. */
	confirm?: string;
}

/** A second click sooner than this is one double-click, not two decisions. */
const CONFIRM_MIN_MS = 400;

/**
 * A `···` overflow button and its dropdown. The dropdown is portaled to
 * document.body and kept inside the window, so an overflow-scrolling ancestor
 * never clips it and a trigger near a window edge never adds scrollbars.
 */
export function Menu({
	items,
	label = "More actions",
	icon: Icon = MoreHorizontal,
	className,
}: {
	items: MenuItem[];
	label?: string;
	icon?: LucideIcon;
	/** Extra classes for the trigger, for a spot that sizes its icon buttons. */
	className?: string;
}) {
	// The item waiting for its confirming click, and when it started waiting.
	// Closing the menu forgets it, so a reopened menu always asks again.
	const [armed, setArmed] = useState<{ label: string; at: number } | null>(null);
	return (
		<DropdownMenu modal={false} onOpenChange={(open) => !open && setArmed(null)}>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					className={className}
					aria-label={label}
					title={label}
				>
					<Icon strokeWidth={1.75} />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" collisionPadding={8} className="w-[210px]">
				{items.map((item) => {
					const waiting = item.confirm != null && armed?.label === item.label;
					return (
						<DropdownMenuItem
							key={item.label}
							variant={item.danger ? "destructive" : "default"}
							disabled={item.disabled}
							className={cn(
								waiting &&
									"bg-destructive/15 font-medium focus:bg-destructive/25 dark:focus:bg-destructive/30",
							)}
							onSelect={(e) => {
								if (item.confirm != null) {
									const now = performance.now();
									if (!waiting || now - armed.at < CONFIRM_MIN_MS) {
										e.preventDefault();
										if (!waiting) setArmed({ label: item.label, at: now });
										return;
									}
								}
								item.onClick();
							}}
						>
							{item.icon && <item.icon className="size-3.5" strokeWidth={1.75} />}
							<span>{waiting ? item.confirm : item.label}</span>
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
