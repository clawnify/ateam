import type { ComponentType } from "react";

/**
 * Any icon the button can render: a lucide icon, or one of our own inlined brand
 * marks (VscodeLogo) — both take `size`, and a brand mark ignores strokeWidth.
 */
export type ButtonIcon = ComponentType<{
	size?: string | number;
	strokeWidth?: string | number;
}>;

export type IconButtonVariant = "default" | "primary" | "yolo" | "danger";

interface IconButtonProps {
	icon: ButtonIcon;
	/** Tooltip label shown on hover (icons carry no visible text). */
	label: string;
	/** Optional shortcut hint shown in the tooltip, e.g. "⌘⏎". */
	shortcut?: string;
	onClick?: () => void;
	variant?: IconButtonVariant;
	/** Toggle buttons: reflect the on-state, so "click again to leave" is visible. */
	active?: boolean;
	disabled?: boolean;
	size?: number;
	/** Something behind the button needs the user: an amber corner dot, with this said
	 *  after the label in the tooltip and to screen readers ("a box needs you"). */
	attention?: string;
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
	active,
	disabled,
	size = 16,
	attention,
}: IconButtonProps) {
	const name = attention ? `${label}: ${attention}` : label;
	return (
		// Native title tooltips: they can't overflow the window edge or create
		// scrollbars the way absolutely-positioned CSS tooltips can.
		<button
			type="button"
			className={`iconbtn ${variant}${active ? " active" : ""}${attention ? " has-attention" : ""}`}
			onClick={onClick}
			disabled={disabled}
			aria-label={name}
			aria-pressed={active}
			title={shortcut ? `${name} (${shortcut})` : name}
		>
			<Icon size={size} strokeWidth={1.75} />
			{attention ? <span className="iconbtn-dot" aria-hidden="true" /> : null}
		</button>
	);
}
