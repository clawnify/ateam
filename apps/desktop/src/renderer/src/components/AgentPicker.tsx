import type { AgentDTO } from "@ateam/protocol";
import { Download } from "lucide-react";
import { useState } from "react";
import { PickerHeading, PickerRow, pickerTrigger } from "./picker";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

// The composer's coding-agent control — the pill + popover the environment picker
// uses, so a *missing* agent on the selected environment can be installed right here
// instead of being a dead "(not installed)" option. Installing asks that environment's
// own engine to run the agent's official installer on itself, which is why the button
// works for this Mac and for a box alike; the one-time OAuth login is a follow-up the
// user runs in a terminal there.

export function AgentPicker({
	agents,
	value,
	onChange,
	isAvailable,
	alias,
	onInstallAgent,
}: {
	agents: AgentDTO[];
	value: string;
	onChange: (agentId: string) => void;
	isAvailable: (agentId: string) => boolean;
	/** The selected environment — the machine an install lands on. null = this Mac. */
	alias: string | null;
	/** Install the agent on the selected environment; resolves with the login step. */
	onInstallAgent?: (alias: string | null, agentId: string) => Promise<{ loginCommand?: string }>;
}) {
	const [open, setOpen] = useState(false);
	const [installing, setInstalling] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loginFor, setLoginFor] = useState<{ agentId: string; command?: string } | null>(null);

	const current = agents.find((a) => a.id === value);
	const label = current?.label ?? value;

	const install = async (agentId: string) => {
		if (!onInstallAgent || installing) return;
		setInstalling(agentId);
		setError(null);
		setLoginFor(null);
		try {
			const res = await onInstallAgent(alias, agentId);
			// The caller has already recorded the engine's own verdict; select it now.
			onChange(agentId);
			setLoginFor({ agentId, command: res.loginCommand });
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setInstalling(null);
		}
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="sm" className={pickerTrigger} title="Coding agent">
					<span>{label}</span>
					{!isAvailable(value) ? (
						<span className="rounded-[5px] bg-secondary px-[5px] py-px text-[10px] text-muted-foreground">
							not installed
						</span>
					) : null}
				</Button>
			</PopoverTrigger>
			<PopoverContent
				side="top"
				align="start"
				collisionPadding={8}
				className="max-h-[min(70vh,460px)] w-[260px] overflow-y-auto p-1.5"
			>
				<PickerHeading>Coding agent</PickerHeading>
				{agents.map((a) => {
					const avail = isAvailable(a.id);
					const canInstall = !avail && !!onInstallAgent;
					return (
						<div key={a.id} className="flex flex-col">
							<div className="flex items-center gap-1.5 pr-2">
								<PickerRow
									className="flex-1"
									title={a.label}
									sub={
										avail
											? undefined
											: alias === null
												? "not installed on this Mac"
												: "not installed on this box"
									}
									selected={a.id === value && avail}
									disabled={!avail}
									onClick={() => {
										onChange(a.id);
										setOpen(false);
									}}
								/>
								{canInstall ? (
									<Button
										variant="secondary"
										size="xs"
										className="border hover:border-foreground hover:bg-secondary"
										disabled={installing !== null}
										onClick={() => void install(a.id)}
									>
										<Download strokeWidth={1.75} />
										{installing === a.id ? "Installing…" : "Install"}
									</Button>
								) : null}
							</div>
							{loginFor?.agentId === a.id ? (
								<div className="px-2.5 pb-2 pl-[34px] text-xs text-muted-foreground">
									Installed ✓ — it signs in on first use.
								</div>
							) : null}
						</div>
					);
				})}
				{error ? <div className="px-2.5 pt-1 pb-2 text-xs text-destructive">{error}</div> : null}
			</PopoverContent>
		</Popover>
	);
}
