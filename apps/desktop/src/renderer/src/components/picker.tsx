import { Check } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";

// The pieces the composer's popover pickers share (Run on, Coding agent): the small
// uppercase heading and the option row. SchedulePicker is a plain dropdown menu and
// gets the same look from DropdownMenuLabel and DropdownMenuRadioItem.

/** The trigger pill the pickers open from: a flat navbar button that truncates. */
export const pickerTrigger = "max-w-[200px] [&>span]:truncate";

export function PickerHeading({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"flex items-center px-2 pt-1 pb-1.5 text-[11px] tracking-[0.4px] text-muted-foreground uppercase",
				className,
			)}
			{...props}
		/>
	);
}

/**
 * One option: an icon, a title, an optional line under it, and a check when it is
 * the picked one. `sub` is truncated to the row; its full text goes in `subTitle`.
 */
export function PickerRow({
	icon,
	title,
	sub,
	subTitle,
	tone,
	selected,
	className,
	...props
}: Omit<ComponentProps<typeof Button>, "title"> & {
	icon?: ReactNode;
	title: ReactNode;
	sub?: ReactNode;
	subTitle?: string;
	/** Colours the sub-line: an error that stops the box, or a warning that doesn't. */
	tone?: "error" | "warn";
	selected?: boolean;
}) {
	return (
		<Button
			variant="ghost"
			className={cn(
				"h-auto w-full min-w-0 justify-start gap-2.5 px-2.5 py-2 text-left text-foreground has-[>svg]:px-2.5",
				selected && "bg-accent",
				className,
			)}
			{...props}
		>
			{icon ? (
				<span
					className={cn(
						"flex text-muted-foreground [&_svg]:size-[15px]",
						selected && "text-foreground",
					)}
				>
					{icon}
				</span>
			) : null}
			<span className="flex min-w-0 flex-1 flex-col gap-px">
				<span className="truncate">{title}</span>
				{sub ? (
					<span
						title={subTitle}
						className={cn(
							"truncate text-xs text-muted-foreground",
							tone === "error" && "text-destructive",
							tone === "warn" && "text-warning",
						)}
					>
						{sub}
					</span>
				) : null}
			</span>
			{selected ? <Check className="size-[15px]" strokeWidth={2.25} /> : null}
		</Button>
	);
}
