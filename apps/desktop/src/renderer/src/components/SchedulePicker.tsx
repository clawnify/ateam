import { pickerTrigger } from "./picker";
import { Button } from "./ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

// A loop's schedule control: the composer's pill + dropdown, like AgentPicker. It
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

function labelOf(v: ScheduleKind): string {
	if (v.kind === "preset") {
		return SCHEDULE_PRESETS.find((p) => p.minutes === v.minutes)?.label ?? "Custom";
	}
	if (v.kind === "daily") return "Every day at";
	if (v.kind === "custom") return "Custom";
	return v.label;
}

/** A kind as the radio group's value: one string per choice the menu offers. */
const keyOf = (v: ScheduleKind) => (v.kind === "preset" ? `preset:${v.minutes}` : v.kind);

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
	const options: { v: ScheduleKind; label: string; disabled?: string | null }[] = [
		...SCHEDULE_PRESETS.map((p) => ({
			v: { kind: "preset", minutes: p.minutes } as ScheduleKind,
			label: p.label,
		})),
		{ v: { kind: "daily" }, label: "Every day at…", disabled: dailyBlockedReason },
		{ v: { kind: "custom" }, label: "Custom…" },
	];

	return (
		<DropdownMenu modal={false}>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className={pickerTrigger}
					title="How often each run fires"
				>
					<span>{labelOf(value)}</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent side="top" align="start" collisionPadding={8} className="w-[220px]">
				<DropdownMenuLabel className="text-[11px] font-normal tracking-[0.4px] text-muted-foreground uppercase">
					Schedule
				</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={keyOf(value)}
					onValueChange={(k) => {
						const picked = options.find((o) => keyOf(o.v) === k);
						if (picked) onChange(picked.v);
					}}
				>
					{options.map((o) => (
						<DropdownMenuRadioItem
							key={o.label}
							value={keyOf(o.v)}
							disabled={!!o.disabled}
							title={o.disabled ?? undefined}
						>
							<span className="flex min-w-0 flex-col gap-px">
								<span className="truncate">{o.label}</span>
								{o.disabled ? (
									<span className="truncate text-xs text-muted-foreground">{o.disabled}</span>
								) : null}
							</span>
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
