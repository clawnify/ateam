import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface RailTileProps extends Omit<ComponentProps<"button">, "title"> {
	/** What the tile stands for: its tooltip and its accessible name. */
	label: string;
	/** A dimmer second line in the tooltip. */
	hint?: string;
	active?: boolean;
}

/**
 * One square of the collapsed sidebar. A tile is an initial or a glyph, so its
 * name lives in a tooltip that opens beside it on hover, and quickly: a native
 * `title` waits for the pointer to rest, which on an icon-only strip reads as
 * no label at all. Needs a TooltipProvider above it (the rail has one).
 *
 * Disabled tiles stay hoverable (aria-disabled rather than `disabled`, which
 * swallows pointer events) so the tooltip can still say why.
 */
export function RailTile({
	label,
	hint,
	active,
	disabled,
	className,
	onClick,
	children,
	...rest
}: RailTileProps) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					className={cn("rail-tile", active && "active", className)}
					aria-label={label}
					aria-disabled={disabled || undefined}
					onClick={disabled ? undefined : onClick}
					{...rest}
				>
					{children}
				</button>
			</TooltipTrigger>
			<TooltipContent side="right" sideOffset={8}>
				{label}
				{hint && <div className="text-xs text-muted-foreground">{hint}</div>}
			</TooltipContent>
		</Tooltip>
	);
}
