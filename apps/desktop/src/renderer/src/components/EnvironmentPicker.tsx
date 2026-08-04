import { Check, Laptop, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// The task's "Run on" control — the pill + popover style the global connection
// switcher used, moved into the New Task dialog. `null` alias = this Mac; a box alias
// runs the task on that VPS (cloning the project there on first use). Disabled
// options (no git remote to clone from) show why they can't be picked.

const POP_W = 260;

export type EnvOption = { alias: string | null; label: string; disabled: boolean };

export function EnvironmentPicker({
	environments,
	value,
	onChange,
}: {
	environments: EnvOption[];
	value: string | null;
	onChange: (alias: string | null) => void;
}) {
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	const btnRef = useRef<HTMLButtonElement>(null);
	const popRef = useRef<HTMLDivElement>(null);

	const isRemote = value !== null;
	const label = environments.find((e) => e.alias === value)?.label ?? "Local";

	const close = () => setPos(null);
	const open = () => {
		const r = btnRef.current?.getBoundingClientRect();
		if (!r) return;
		const height = Math.min(environments.length * 46 + 44, 340);
		const left = Math.max(8, Math.min(r.left, window.innerWidth - POP_W - 8));
		// Open UPWARD — the composer footer sits low in the dialog.
		setPos({ top: Math.max(8, r.top - height - 6), left });
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

	const pick = (env: EnvOption) => {
		if (env.disabled) return;
		onChange(env.alias);
		close();
	};

	return (
		<>
			<button
				type="button"
				ref={btnRef}
				className="navbtn conn-btn"
				title="Run on — which machine runs this task"
				onClick={() => (pos ? close() : open())}
			>
				{isRemote ? (
					<Server size={14} strokeWidth={1.75} />
				) : (
					<Laptop size={14} strokeWidth={1.75} />
				)}
				<span>{label}</span>
				<span className={`conn-dot ${isRemote ? "on" : ""}`} />
			</button>
			{pos &&
				createPortal(
					<div
						ref={popRef}
						className="menu-pop conn-pop"
						style={{ position: "fixed", top: pos.top, left: pos.left, width: POP_W, zIndex: 2000 }}
					>
						<div className="conn-head">
							<span>Run on</span>
						</div>
						{environments.map((env) => (
							<button
								key={env.label}
								type="button"
								className={`conn-row ${env.alias === value ? "active" : ""}`}
								disabled={env.disabled}
								onClick={() => pick(env)}
							>
								<span className="conn-ico">
									{env.alias === null ? (
										<Laptop size={15} strokeWidth={1.75} />
									) : (
										<Server size={15} strokeWidth={1.75} />
									)}
								</span>
								<span className="conn-txt">
									<span className="conn-title">{env.label}</span>
									{env.disabled && env.alias !== null && (
										<span className="conn-sub">no git remote to clone</span>
									)}
								</span>
								{env.alias === value ? <Check size={15} strokeWidth={2.25} /> : null}
							</button>
						))}
					</div>,
					document.body,
				)}
		</>
	);
}
