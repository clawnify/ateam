import type { LucideIcon } from "lucide-react";
import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface MenuItem {
	label: string;
	icon?: LucideIcon;
	onClick: () => void;
	danger?: boolean;
	disabled?: boolean;
}

/**
 * A `···` overflow button that opens a small dropdown of secondary actions —
 * the VSCode pattern for keeping toolbars to a few primary icons.
 */
export function Menu({
	items,
	label = "More actions",
	icon: Icon = MoreHorizontal,
}: {
	items: MenuItem[];
	label?: string;
	icon?: LucideIcon;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onDoc = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [open]);

	return (
		<div className="menu" ref={ref}>
			<button
				type="button"
				className="iconbtn"
				aria-label={label}
				data-tip={label}
				onClick={() => setOpen((v) => !v)}
			>
				<Icon size={16} strokeWidth={1.75} />
			</button>
			{open && (
				<div className="menu-pop">
					{items.map((item) => (
						<button
							type="button"
							key={item.label}
							className={`menu-item ${item.danger ? "danger" : ""}`}
							disabled={item.disabled}
							onClick={() => {
								setOpen(false);
								item.onClick();
							}}
						>
							{item.icon && <item.icon size={14} strokeWidth={1.75} />}
							<span>{item.label}</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}
