import type { LucideIcon } from "lucide-react";
import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
	label: string;
	icon?: LucideIcon;
	onClick: () => void;
	danger?: boolean;
	disabled?: boolean;
}

const MENU_W = 210;
const ITEM_H = 32;

/**
 * A `···` overflow button whose dropdown is PORTALED to document.body with a
 * fixed, viewport-clamped position — so it's never clipped by an
 * overflow-scrolling ancestor and never makes scrollbars appear when the
 * trigger sits near a window edge.
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
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	const btnRef = useRef<HTMLButtonElement>(null);
	const popRef = useRef<HTMLDivElement>(null);

	const close = () => setPos(null);

	const toggle = () => {
		if (pos) {
			close();
			return;
		}
		const r = btnRef.current?.getBoundingClientRect();
		if (!r) return;
		const height = items.length * ITEM_H + 10;
		let top = r.bottom + 4;
		if (top + height > window.innerHeight - 8) {
			top = Math.max(8, r.top - height - 4);
		}
		let left = r.right - MENU_W;
		left = Math.min(left, window.innerWidth - MENU_W - 8);
		left = Math.max(8, left);
		setPos({ top, left });
	};

	useEffect(() => {
		if (!pos) return;
		const onDoc = (e: MouseEvent) => {
			const t = e.target as Node;
			if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
			close();
		};
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [pos]);

	return (
		<>
			<button
				type="button"
				ref={btnRef}
				className="iconbtn"
				aria-label={label}
				title={label}
				onClick={toggle}
			>
				<Icon size={16} strokeWidth={1.75} />
			</button>
			{pos &&
				createPortal(
					<div
						ref={popRef}
						className="menu-pop"
						style={{
							position: "fixed",
							top: pos.top,
							left: pos.left,
							right: "auto",
							width: MENU_W,
							zIndex: 1000,
						}}
					>
						{items.map((item) => (
							<button
								type="button"
								key={item.label}
								className={`menu-item ${item.danger ? "danger" : ""}`}
								disabled={item.disabled}
								onClick={() => {
									close();
									item.onClick();
								}}
							>
								{item.icon && <item.icon size={14} strokeWidth={1.75} />}
								<span>{item.label}</span>
							</button>
						))}
					</div>,
					document.body,
				)}
		</>
	);
}
