import { aliasLabel, type EngineMember, type UnifiedProject } from "@ateam/protocol";
import { ChevronDown, Layers, Monitor, Server } from "lucide-react";
import type { DragEvent } from "react";
import { cn } from "@/lib/utils";
import { pickerTrigger } from "./picker";
import { Button } from "./ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

// The project switcher: one dropdown in the sidebar's top strip in place of the
// old PROJECTS accordion, and a Project pill for the New task and New loop
// dialogs while the board shows every project.

/** The radio value of "All projects"; a card key never starts with "__". */
const ALL = "__all__";

/** The project's own colour, never a status. */
function ProjectDot({ color }: { color: string | null }) {
	return <span className="project-dot" style={color ? { background: color } : undefined} />;
}

/** One icon per machine the repo is on (a monitor for this Mac, a server per
 *  box), shown only once it is on more than this Mac: the multi-engine cue the
 *  Projects rows carried. The name is the hover title. */
function Machines({ members }: { members: EngineMember[] }) {
	if (members.length < 2 && members.every((m) => m.alias === null)) return null;
	return (
		<span className="flex flex-none items-center gap-[3px] text-muted-foreground">
			{members.map((m) => {
				const name = aliasLabel(m.alias);
				return (
					<span key={m.alias ?? "local"} className="inline-flex" title={name}>
						{m.alias === null ? (
							<Monitor className="size-3" strokeWidth={1.75} aria-label={name} />
						) : (
							<Server className="size-3" strokeWidth={1.75} aria-label={name} />
						)}
					</span>
				);
			})}
		</span>
	);
}

/**
 * The sidebar's project switcher: All projects, then each repo card, then Add
 * project and the selected project's own actions. Files from Finder dropped on
 * it start a task in the project it names (`drop`), as the rows used to.
 */
export function ProjectSwitcher({
	cards,
	activeKey,
	all,
	onSelect,
	onSelectAll,
	onAdd,
	onOpenWindow,
	onRemove,
	drop,
	dropping,
}: {
	cards: UnifiedProject[];
	/** The selected card's key (the one New task targets, even under All). */
	activeKey: string | null;
	all: boolean;
	onSelect: (card: UnifiedProject) => void;
	onSelectAll: () => void;
	onAdd: () => void;
	onOpenWindow: (card: UnifiedProject) => void;
	onRemove: (member: EngineMember) => void;
	/** Absent while there is no project to start a task in. */
	drop?: {
		onDragOver: (e: DragEvent) => void;
		onDragLeave: (e: DragEvent) => void;
		onDrop: (e: DragEvent) => void;
	};
	dropping: boolean;
}) {
	const active = cards.find((c) => c.key === activeKey) ?? null;
	const label = all ? "All projects" : (active?.name ?? "No project");
	return (
		<DropdownMenu modal={false}>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					// The row's full width; 6px in, so the dot lines up with the task icons.
					className={cn(
						"project-switcher h-8 w-full min-w-0 justify-start px-1.5 text-[13px] font-medium text-foreground has-[>svg]:px-1.5",
						dropping && "file-drop",
					)}
					title="Switch project"
					aria-label={`Project: ${label}`}
					{...drop}
				>
					{all ? (
						<Layers className="size-3.5" strokeWidth={1.75} />
					) : (
						<ProjectDot color={active?.color ?? null} />
					)}
					<span className="truncate">{label}</span>
					<ChevronDown className="ml-auto size-3.5 text-muted-foreground" strokeWidth={2} />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				collisionPadding={8}
				className="w-(--radix-dropdown-menu-trigger-width) min-w-[228px]"
			>
				<DropdownMenuRadioGroup
					value={all ? ALL : (activeKey ?? "")}
					onValueChange={(v) => {
						if (v === ALL) return onSelectAll();
						const card = cards.find((c) => c.key === v);
						if (card) onSelect(card);
					}}
				>
					<DropdownMenuRadioItem value={ALL}>
						<Layers className="size-3.5" strokeWidth={1.75} />
						All projects
					</DropdownMenuRadioItem>
					{cards.length > 0 && <DropdownMenuSeparator />}
					{cards.map((card) => (
						<DropdownMenuRadioItem key={card.key} value={card.key}>
							<ProjectDot color={card.color} />
							<span className="min-w-0 flex-1 truncate" title={card.members[0]?.project.repoPath}>
								{card.name}
							</span>
							<Machines members={card.members} />
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={onAdd}>Add project…</DropdownMenuItem>
				{/* The selected project's actions, which its row's ··· menu held.
				    Under All there is no one project to act on. */}
				{!all && active && (
					<>
						<DropdownMenuItem onSelect={() => onOpenWindow(active)}>
							Open {active.name} in new window
						</DropdownMenuItem>
						{active.members.map((member) => (
							<DropdownMenuItem
								key={member.projectId}
								variant="destructive"
								onSelect={() => onRemove(member)}
							>
								{active.members.length > 1 || member.alias !== null
									? `Remove ${active.name} from ${aliasLabel(member.alias)}…`
									: `Remove ${active.name}…`}
							</DropdownMenuItem>
						))}
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** The static header of a detached window: the one project it is pinned to. */
export function ProjectTitle({
	name,
	color,
	path,
}: {
	name: string;
	color: string | null;
	path?: string;
}) {
	return (
		<span className="project-title" title={path}>
			<ProjectDot color={color} />
			<span className="truncate">{name}</span>
		</span>
	);
}

/**
 * The New task and New loop dialogs' Project pill, shown while the board holds
 * every project: which repo the new work lands in. Picking another re-points
 * the dialog's machines at that repo; what was typed stays.
 */
export function ProjectPicker({
	cards,
	value,
	onChange,
}: {
	cards: UnifiedProject[];
	value: string | null;
	onChange: (card: UnifiedProject) => void;
}) {
	const picked = cards.find((c) => c.key === value) ?? null;
	return (
		<DropdownMenu modal={false}>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="sm" className={pickerTrigger} title="Project">
					<ProjectDot color={picked?.color ?? null} />
					<span>{picked?.name ?? "Project"}</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent side="top" align="start" collisionPadding={8} className="w-[240px]">
				<DropdownMenuRadioGroup
					value={value ?? ""}
					onValueChange={(v) => {
						const card = cards.find((c) => c.key === v);
						if (card) onChange(card);
					}}
				>
					{cards.map((card) => (
						<DropdownMenuRadioItem key={card.key} value={card.key}>
							<ProjectDot color={card.color} />
							<span className="min-w-0 flex-1 truncate">{card.name}</span>
							<Machines members={card.members} />
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
