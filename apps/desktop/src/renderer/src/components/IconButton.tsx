import type { LucideIcon } from "lucide-react";

export type IconButtonVariant = "default" | "primary" | "yolo" | "danger";

interface IconButtonProps {
	icon: LucideIcon;
	/** Tooltip label shown on hover (icons carry no visible text). */
	label: string;
	/** Optional shortcut hint shown in the tooltip, e.g. "⌘⏎". */
	shortcut?: string;
	onClick?: () => void;
	variant?: IconButtonVariant;
	disabled?: boolean;
	size?: number;
}

/**
 * VSCode-style ghost icon button: no border/fill at rest, subtle hover, label
 * surfaced via a hover tooltip rather than always-visible text.
 */
export function IconButton({
	icon: Icon,
	label,
	shortcut,
	onClick,
	variant = "default",
	disabled,
	size = 16,
}: IconButtonProps) {
	return (
		<button
			type="button"
			className={`iconbtn ${variant}`}
			onClick={onClick}
			disabled={disabled}
			aria-label={label}
			data-tip={shortcut ? `${label}  ${shortcut}` : label}
		>
			<Icon size={size} strokeWidth={1.75} />
		</button>
	);
}
