/**
 * lucide's `PanelRight` with the docked pane painted in — the ON state for the
 * terminal-sidebar toggle, the way VS Code fills its own panel icons rather than
 * relying on colour alone.
 *
 * lucide ships no solid variant (its `panel-right` is an 18×18 rounded rect plus
 * a divider at x=15), so that geometry is repeated here with the right section
 * filled. The two states are then pixel-identical apart from the fill, which is
 * the whole point: the icon must not appear to move when it toggles.
 */
export function PanelRightFilled({
	size = 16,
	strokeWidth = 1.75,
}: {
	size?: string | number;
	strokeWidth?: string | number;
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={strokeWidth}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			xmlns="http://www.w3.org/2000/svg"
		>
			{/* The pane itself, tracing the rect's rounded right-hand corners. */}
			<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4z" fill="currentColor" stroke="none" />
			<rect width="18" height="18" x="3" y="3" rx="2" />
			<path d="M15 3v18" />
		</svg>
	);
}
