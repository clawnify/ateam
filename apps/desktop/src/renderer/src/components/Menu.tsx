import type { LucideIcon } from "lucide-react";
import { MoreHorizontal } from "lucide-react";
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
}

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
	return (
		<DropdownMenu modal={false}>
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
				{items.map((item) => (
					<DropdownMenuItem
						key={item.label}
						variant={item.danger ? "destructive" : "default"}
						disabled={item.disabled}
						onSelect={item.onClick}
					>
						{item.icon && <item.icon className="size-3.5" strokeWidth={1.75} />}
						<span>{item.label}</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
