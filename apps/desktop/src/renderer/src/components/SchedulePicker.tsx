import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// A loop's schedule control: the composer's pill + popover, like AgentPicker. It
// only picks WHICH kind of schedule. The loop form renders the one input a kind
// needs beside it (a time for "Every day at", minutes for "Custom").

/** The interval presets, in minutes. */
export const SCHEDULE_PRESETS = [
	{ minutes: 15, label: "Every 15 minutes" },
	{ minutes: 30, label: "Every 30 minutes" },
	{ minutes: 60, label: "Every hour" },
	{ minutes: 360, label: "Every 6 hours" },
	{ minutes: 720, label: "Every 12 hours" },
] as const;

export type ScheduleKind =
	| { kind: "preset"; minutes: number }
	| { kind: "daily" }
	| { kind: "custom" }
	/** A calendar the UI didn't write (not "daily at"): shown, and kept as is. */
	| { kind: "other"; label: string };

const POP_W = 220;

function labelOf(v: ScheduleKind): string {
	if (v.kind === "preset") {
		return SCHEDULE_PRESETS.find((p) => p.minutes === v.minutes)?.label ?? "Custom";
	}
	if (v.kind === "daily") return "Every day at";
	if (v.kind === "custom") return "Custom";
	return v.label;
}

const same = (a: ScheduleKind, b: ScheduleKind) =>
	a.kind === b.kind && (a.kind !== "preset" || (b.kind === "preset" && a.minutes === b.minutes));

export function SchedulePicker({
	value,
	onChange,
	dailyBlockedReason,
}: {
	value: ScheduleKind;
	onChange: (v: ScheduleKind) => void;
	/** Set when the environment's engine is too old for "Every day at". */
	dailyBlockedReason: string | null;
}) {
	const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);
	const btnRef = useRef<HTMLButtonElement>(null);
	const popRef = useRef<HTMLDivElement>(null);

	const close = () => setPos(null);
	const open = () => {
		const r = btnRef.current?.getBoundingClientRect();
		if (!r) return;
		const left = Math.max(8, Math.min(r.left, window.innerWidth - POP_W - 8));
		setPos({ bottom: window.innerHeight - r.top + 6, left });
	};

	useEffect(() => {
		if (!pos) return;
		const onDoc = (e: MouseEvent) => {
			const t = e.target as Node;
			if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
			setPos(null);
		};
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [pos]);

	const options: { v: ScheduleKind; label: string; disabled?: string | null }[] = [
		...SCHEDULE_PRESETS.map((p) => ({
			v: { kind: "preset", minutes: p.minutes } as ScheduleKind,
			label: p.label,
		})),
		{ v: { kind: "daily" }, label: "Every day at…", disabled: dailyBlockedReason },
		{ v: { kind: "custom" }, label: "Custom…" },
	];

	return (
		<>
			<button
				type="button"
				ref={btnRef}
				className="navbtn conn-btn"
				title="How often each run fires"
				aria-haspopup="menu"
				aria-expanded={pos !== null}
				onClick={() => (pos ? close() : open())}
			>
				<span>{labelOf(value)}</span>
			</button>
			{pos &&
				createPortal(
					<div
						ref={popRef}
						role="menu"
						className="menu-pop conn-pop"
						style={{
							position: "fixed",
							top: "auto",
							right: "auto",
							bottom: pos.bottom,
							left: pos.left,
							width: POP_W,
							zIndex: 2000,
						}}
					>
						<div className="conn-head">
							<span>Schedule</span>
						</div>
						{options.map((o) => (
							<button
								type="button"
								role="menuitemradio"
								aria-checked={same(o.v, value)}
								key={o.label}
								className={`conn-row ${same(o.v, value) ? "active" : ""}`}
								disabled={!!o.disabled}
								title={o.disabled ?? undefined}
								onClick={() => {
									onChange(o.v);
									close();
								}}
							>
								<span className="conn-txt">
									<span className="conn-title">{o.label}</span>
									{o.disabled ? <span className="conn-sub">{o.disabled}</span> : null}
								</span>
								{same(o.v, value) ? <Check size={15} strokeWidth={2.25} /> : null}
							</button>
						))}
					</div>,
					document.body,
				)}
		</>
	);
}
