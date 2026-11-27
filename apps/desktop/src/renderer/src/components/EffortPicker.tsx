import {
	type AgentEffort,
	type Effort,
	EFFORT_LEVELS,
	effortLabel,
	resolveEffort,
} from "@ateam/protocol";
import { useEffect, useState } from "react";
import { PickerHeading, PickerRow, pickerTrigger } from "./picker";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export function EffortPicker({
	projectId,
	agentId,
	loopId,
	value,
	onChange,
}: {
	projectId?: string;
	agentId: string;
	loopId?: string;
	value: Effort | null;
	onChange: (value: Effort | null) => void;
}) {
	const [open, setOpen] = useState(false);
	const key = JSON.stringify([projectId, agentId, loopId]);
	const [loaded, setLoaded] = useState<{ key: string; data: AgentEffort | null }>();
	useEffect(() => {
		if (!projectId) return;
		let current = true;
		void window.ateam.agents.effort({ projectId, agentId, loopId }).then(
			(data) => {
				if (current) setLoaded({ key, data });
			},
			() => {
				if (current) setLoaded({ key, data: null });
			},
		);
		return () => {
			current = false;
		};
	}, [key, projectId, agentId, loopId]);

	const data = loaded?.key === key ? loaded.data : null;
	const levels = data?.levels ?? [];
	if (!levels.length && !value) return null;
	const applied = value ? resolveEffort(value, levels) : null;
	const options = [
		null,
		...EFFORT_LEVELS.filter((level) => level === value || levels.includes(level)),
	];
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="sm" className={pickerTrigger} title={data?.model}>
					<span>Effort · {effortLabel(value)}</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent side="top" align="start" className="w-[220px] p-1.5">
				<PickerHeading>{data ? `Effort · ${data.model}` : "Effort"}</PickerHeading>
				{options.map((level) => (
					<PickerRow
						key={level ?? "default"}
						title={effortLabel(level)}
						sub={
							data && level && level === value && level !== applied
								? `Uses ${effortLabel(applied)}`
								: undefined
						}
						selected={level === value}
						onClick={() => {
							onChange(level);
							setOpen(false);
						}}
					/>
				))}
			</PopoverContent>
		</Popover>
	);
}
