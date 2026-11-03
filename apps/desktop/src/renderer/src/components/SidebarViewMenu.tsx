import { type Alias, aliasLabel, type KanbanColumn } from "@ateam/protocol";
import { ListFilter } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
	filtersSet,
	type PrKey,
	type SidebarView,
	type TaskGrouping,
	type TaskSortMode,
	toggled,
} from "../sidebar-view";
import { Button } from "./ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuPortal,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

// Options are words only, with the check on the right: no icon per option.
const GROUPINGS: { value: TaskGrouping; label: string }[] = [
	{ value: "none", label: "None" },
	{ value: "status", label: "Status" },
	{ value: "machine", label: "Machine" },
	{ value: "updated", label: "Last updated" },
	{ value: "project", label: "Project" },
];

const ORDERINGS: { value: TaskSortMode; label: string }[] = [
	{ value: "next", label: "What's next" },
	{ value: "status", label: "Status" },
	{ value: "updated", label: "Last updated" },
	{ value: "custom", label: "Custom (drag)" },
];

const PRS: { value: PrKey; label: string }[] = [
	{ value: "none", label: "No PR" },
	{ value: "open", label: "Open" },
	{ value: "merged", label: "Merged" },
	{ value: "closed", label: "Closed" },
];

/** A submenu row: its name, then the current value dim on the right. */
function Sub({ label, value, children }: { label: string; value?: string; children: ReactNode }) {
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<span className="flex-1">{label}</span>
				{value && <span className="text-muted-foreground">{value}</span>}
			</DropdownMenuSubTrigger>
			<DropdownMenuPortal>
				<DropdownMenuSubContent className="min-w-[180px]">{children}</DropdownMenuSubContent>
			</DropdownMenuPortal>
		</DropdownMenuSub>
	);
}

/** One multi-select filter value. Ticking keeps the menu open, so several can
 *  be set in one visit. */
function FilterItem({
	label,
	shown,
	onToggle,
}: {
	label: string;
	shown: boolean;
	onToggle: () => void;
}) {
	return (
		<DropdownMenuCheckboxItem
			checked={shown}
			onCheckedChange={onToggle}
			onSelect={(e) => e.preventDefault()}
		>
			{label}
		</DropdownMenuCheckboxItem>
	);
}

/**
 * The view menu on the sidebar's TASKS header: grouping, ordering, filters,
 * folding the groups and marking the list read. Radix gives it the keyboard:
 * arrows move, → opens a submenu, ← closes it, Esc closes the menu.
 */
export function SidebarViewMenu({
	view,
	onView,
	sort,
	onSort,
	statuses,
	machines,
	groupKeys,
	unread,
	onMarkAllRead,
	allProjects,
}: {
	view: SidebarView;
	onView: (v: SidebarView) => void;
	sort: TaskSortMode;
	onSort: (s: TaskSortMode) => void;
	/** The board's columns, in its own words and order. */
	statuses: { key: KanbanColumn; label: string }[];
	/** The machines this project is on (null is this Mac). */
	machines: Alias[];
	/** The groups on screen, which Collapse all / Expand all act on. */
	groupKeys: string[];
	/** Unread tasks among the ones the filters let through. */
	unread: number;
	onMarkAllRead: () => void;
	/** The list holds every project, so it can be grouped by project. */
	allProjects: boolean;
}) {
	const lit = filtersSet(view, machines);
	const label = lit ? "View options (filters on)" : "View options";
	const allFolded = groupKeys.length > 0 && groupKeys.every((k) => view.collapsed.includes(k));
	const fold = () =>
		onView({
			...view,
			collapsed: allFolded
				? view.collapsed.filter((k) => !groupKeys.includes(k))
				: [...new Set([...view.collapsed, ...groupKeys])],
		});
	return (
		<DropdownMenu modal={false}>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					// The section header's icon buttons are 24px (.section-head .iconbtn).
					// White while a filter is set, so a short list is never a mystery.
					className={cn("size-6", lit && "text-foreground")}
					aria-label={label}
					title={label}
				>
					{/* 14px: its lines run edge to edge, so at the + beside it's 16px it
					    reads the bigger of the two. */}
					<ListFilter className="size-3.5" strokeWidth={1.75} />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent side="right" align="start" collisionPadding={8} className="w-[230px]">
				<Sub label="Grouping" value={GROUPINGS.find((g) => g.value === view.grouping)?.label}>
					<DropdownMenuRadioGroup
						value={view.grouping}
						onValueChange={(g) => onView({ ...view, grouping: g as TaskGrouping })}
					>
						{GROUPINGS.filter((g) => allProjects || g.value !== "project").map(
							({ value, label }) => (
								<DropdownMenuRadioItem key={value} value={value}>
									{label}
								</DropdownMenuRadioItem>
							),
						)}
					</DropdownMenuRadioGroup>
				</Sub>
				<Sub label="Ordering" value={ORDERINGS.find((o) => o.value === sort)?.label}>
					<DropdownMenuRadioGroup value={sort} onValueChange={(s) => onSort(s as TaskSortMode)}>
						{ORDERINGS.map(({ value, label }) => (
							<DropdownMenuRadioItem key={value} value={value}>
								{label}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</Sub>
				<DropdownMenuSeparator />
				<DropdownMenuLabel className="text-[11px] font-normal tracking-[0.4px] text-muted-foreground uppercase">
					Filters
				</DropdownMenuLabel>
				<Sub label="Status">
					{statuses.map(({ key, label }) => (
						<FilterItem
							key={key}
							label={label}
							shown={!view.hiddenStatus.includes(key)}
							onToggle={() => onView({ ...view, hiddenStatus: toggled(view.hiddenStatus, key) })}
						/>
					))}
				</Sub>
				<Sub label="PR">
					{PRS.map(({ value, label }) => (
						<FilterItem
							key={value}
							label={label}
							shown={!view.hiddenPr.includes(value)}
							onToggle={() => onView({ ...view, hiddenPr: toggled(view.hiddenPr, value) })}
						/>
					))}
				</Sub>
				<Sub label="Machine">
					{machines.map((m) => (
						<FilterItem
							key={m ?? ""}
							label={aliasLabel(m)}
							shown={!view.hiddenMachines.includes(m)}
							onToggle={() => onView({ ...view, hiddenMachines: toggled(view.hiddenMachines, m) })}
						/>
					))}
				</Sub>
				<DropdownMenuCheckboxItem
					checked={view.showArchived}
					onCheckedChange={() => onView({ ...view, showArchived: !view.showArchived })}
					onSelect={(e) => e.preventDefault()}
				>
					Archived
				</DropdownMenuCheckboxItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem disabled={groupKeys.length === 0} onSelect={fold}>
					{allFolded ? "Expand all" : "Collapse all"}
				</DropdownMenuItem>
				<DropdownMenuItem disabled={unread === 0} onSelect={onMarkAllRead}>
					Mark all as read
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
