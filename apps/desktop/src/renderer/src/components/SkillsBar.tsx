import type { SkillDTO } from "@ateam/protocol";
import { Pin, Plus, SquareSlash } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/** How many skills a first run pins, from the ones typed most. */
const SEED_PINS = 5;

// The pinned skills (`client.pinnedSkills`) are one list for every terminal, so
// they live in one store: pinning in one task's toolbar shows in all the others
// at once. `undefined` = not loaded yet; `null` = never chosen, so the first
// skill list that arrives seeds it from usage.
let pins: string[] | null | undefined;
let seeding = false;
const listeners = new Set<() => void>();
const emit = () => {
	for (const l of listeners) l();
};
let loading: Promise<void> | null = null;
const loadPins = () => {
	loading ??= window.ateam.settings
		.get()
		.then((r) => {
			pins = r.settings.client.pinnedSkills ?? null;
		})
		.catch(() => {
			pins = null;
		})
		.finally(emit);
	return loading;
};
const savePins = async (next: string[]) => {
	pins = next;
	emit();
	await window.ateam.settings.update({ client: { pinnedSkills: next } });
};
const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};
const usePins = () => useSyncExternalStore(subscribe, () => pins);

/** `greybeard:pressure-test` → `pressure-test`: what fits on a button. */
const shortName = (name: string) => name.slice(name.lastIndexOf(":") + 1);

/** How many times a skill was sent in this terminal's conversation, in words. */
const sentText = (n: number) =>
	n ? `Sent ${n === 1 ? "once" : `${n} times`} in this session` : "Not sent in this session yet";

/** After you send a prompt, when to recount (ms): the agent writes it to its
 *  transcript at once, unless a turn is running and it waits in the queue. */
const RECOUNT_AFTER = [1500, 6000];

/**
 * The skills half of an agent terminal's toolbar: a menu of every skill the
 * agent can see, and the pinned ones as buttons. Choosing a skill hands its
 * command to `onInsert`, which puts it in front of the prompt being typed;
 * it never presses Enter, so the user still sends it.
 */
export function SkillsBar({
	terminalId,
	submits,
	buttons = "pinned",
	onInsert,
	onAddSkill,
}: {
	terminalId: string;
	/** Goes up each time a prompt is sent from this terminal: time to recount. */
	submits: number;
	/** Which skills get a button: the pinned ones, or the ones already sent in
	 *  this session, pinned or not (a Mission Control tile, too narrow for every pin). */
	buttons?: "pinned" | "sent";
	/** Type `command` into the agent's input. False: the draft is unknown, nothing typed. */
	onInsert: (command: string) => boolean;
	/** Link a new skill (this Mac only). Absent: no "Add skill…" item. */
	onAddSkill?: () => Promise<void>;
}) {
	const [skills, setSkills] = useState<SkillDTO[] | null>(null);
	const [failed, setFailed] = useState(false);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [hint, setHint] = useState(false);
	const hintTimer = useRef(0);
	const pinned = usePins();

	const refresh = useCallback(async () => {
		try {
			setSkills(await window.ateam.skills.list(terminalId));
			setFailed(false);
		} catch {
			// An engine older than skills:list (a box not yet updated) answers
			// "Unknown method": no skills there, and the menu says why.
			setSkills([]);
			setFailed(true);
		}
	}, [terminalId]);

	useEffect(() => {
		void loadPins();
		void refresh();
	}, [refresh]);
	useEffect(() => () => clearTimeout(hintTimer.current), []);
	// A prompt just went out, possibly a skill: recount this session's uses. The
	// first run is the mount, which the effect above already covers.
	const seenSubmits = useRef(submits);
	useEffect(() => {
		if (submits === seenSubmits.current) return;
		seenSubmits.current = submits;
		const timers = RECOUNT_AFTER.map((ms) => window.setTimeout(() => void refresh(), ms));
		return () => {
			for (const t of timers) clearTimeout(t);
		};
	}, [submits, refresh]);

	// First run: pin the skills typed most, then leave the list alone. Saved
	// rather than recomputed, so the buttons don't move as usage shifts.
	useEffect(() => {
		if (pinned !== null || !skills || seeding) return;
		const top = skills.filter((s) => s.uses > 0).slice(0, SEED_PINS);
		if (!top.length) return;
		seeding = true;
		void savePins(top.map((s) => s.name)).finally(() => {
			seeding = false;
		});
	}, [pinned, skills]);

	const byName = useMemo(() => new Map((skills ?? []).map((s) => [s.name, s])), [skills]);
	// A pinned skill this agent can't see (a Claude plugin skill in a Codex
	// terminal) is skipped here, not dropped from the list. Sent ones go most
	// sent first; ties keep the list's most-typed order (sort is stable).
	const chips =
		buttons === "sent"
			? (skills ?? [])
					.filter((s) => s.sessionUses > 0)
					.sort((a, b) => b.sessionUses - a.sessionUses)
			: (pinned ?? []).map((n) => byName.get(n)).filter((s): s is SkillDTO => !!s);
	const pinnedSet = new Set(pinned ?? []);
	const q = query.trim().toLowerCase();
	const filtered = (skills ?? []).filter(
		(s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
	);

	const insert = (s: SkillDTO) => {
		setOpen(false);
		if (onInsert(s.command)) return;
		setHint(true);
		clearTimeout(hintTimer.current);
		hintTimer.current = window.setTimeout(() => setHint(false), 4000);
	};
	const togglePin = (name: string) =>
		void savePins(
			pinnedSet.has(name) ? (pinned ?? []).filter((n) => n !== name) : [...(pinned ?? []), name],
		);

	return (
		<>
			<Popover
				open={open}
				onOpenChange={(o) => {
					setOpen(o);
					if (o) {
						setQuery("");
						// The agent watches its folders, so the list can change mid-session.
						void refresh();
					}
				}}
			>
				<PopoverTrigger asChild>
					<Button variant="ghost" size="icon-sm" aria-label="Skills" title="Skills">
						<SquareSlash strokeWidth={1.75} />
					</Button>
				</PopoverTrigger>
				{/* The toolbar sits at the bottom of the window, so the menu opens upward. */}
				<PopoverContent
					side="top"
					align="start"
					collisionPadding={8}
					className="flex w-[360px] flex-col gap-1 p-1"
					// Typing a skill goes to the terminal, so focus must not bounce back to the trigger.
					onCloseAutoFocus={(e) => e.preventDefault()}
				>
					<Input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							const first = filtered[0];
							if (e.key === "Enter" && first) insert(first);
						}}
						placeholder="Search skills"
						aria-label="Search skills"
						className="h-7 text-xs"
					/>
					<div className="max-h-[320px] overflow-y-auto">
						{filtered.map((s) => (
							<div key={s.name} className="skill-row">
								<button
									type="button"
									className="skill-row-main"
									title={s.path}
									onClick={() => insert(s)}
								>
									<span className="skill-row-name">{s.command}</span>
									{s.description && <span className="skill-row-desc">{s.description}</span>}
								</button>
								{/* Counted from this agent's own prompt history (skills.ts typedCommands). */}
								{/* Sent in this conversation, from its transcript (skills.ts sessionCommands). */}
								{s.sessionUses > 0 && (
									<span className="skill-row-uses" title={sentText(s.sessionUses)}>
										{s.sessionUses}×
									</span>
								)}
								<button
									type="button"
									className="skill-row-pin"
									data-pinned={pinnedSet.has(s.name)}
									aria-label={
										pinnedSet.has(s.name) ? `Unpin ${s.name}` : `Pin ${s.name} to the toolbar`
									}
									title={pinnedSet.has(s.name) ? "Unpin from the toolbar" : "Pin to the toolbar"}
									onClick={() => togglePin(s.name)}
								>
									{/* Filled once pinned: a struck-through pin read as "not pinned". */}
									<Pin
										size={13}
										strokeWidth={1.75}
										fill={pinnedSet.has(s.name) ? "currentColor" : "none"}
									/>
								</button>
							</div>
						))}
						{skills && !filtered.length && (
							<div className="skill-empty muted">
								{failed
									? "This box's Ateam can't list skills yet. Update the box."
									: q
										? "No skill matches."
										: "This agent has no skills yet."}
							</div>
						)}
						{!skills && <div className="skill-empty muted">Loading…</div>}
					</div>
					{onAddSkill && (
						<Button
							variant="ghost"
							size="xs"
							className="justify-start text-foreground"
							onClick={() => {
								setOpen(false);
								void onAddSkill().then(refresh);
							}}
						>
							<Plus strokeWidth={1.75} />
							Add skill…
						</Button>
					)}
				</PopoverContent>
			</Popover>
			<span className="skill-chips">
				{chips.map((s) => (
					<Button
						key={s.name}
						variant="ghost"
						size="xs"
						className="h-[18px] shrink-0 rounded-[4px] px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
						title={`${s.command}${s.description ? `: ${s.description}` : ""}\n${sentText(s.sessionUses)}`}
						// Keep focus in the terminal: the command types into it.
						onMouseDown={(e) => e.preventDefault()}
						onClick={() => insert(s)}
					>
						{shortName(s.name)}
						{/* Already sent here: so you can see it before sending it twice. */}
						{s.sessionUses > 0 && <span className="skill-chip-sent">{s.sessionUses}×</span>}
					</Button>
				))}
				{hint && <span className="skill-hint">Clear the prompt or send it, then click again</span>}
			</span>
		</>
	);
}
