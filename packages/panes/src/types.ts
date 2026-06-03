// Layout-tree types for splitting terminal panes — used by the renderer's
// Mission Control grid and per-task multi-pane views. A workspace holds tabs;
// each tab is a binary split tree whose leaves reference panes by id.

export type SplitDirection = "horizontal" | "vertical";

export type SplitPosition = "top" | "right" | "bottom" | "left";

export type SplitBranch = "first" | "second";

export type SplitPath = SplitBranch[];

export type LayoutNode =
	| { type: "pane"; paneId: string }
	| {
			type: "split";
			direction: SplitDirection;
			first: LayoutNode;
			second: LayoutNode;
			/** First child's size as a percentage (0–100); defaults to 50. */
			splitPercentage?: number;
	  };

export interface Pane<TData> {
	id: string;
	kind: string;
	titleOverride?: string;
	pinned?: boolean;
	data: TData;
}

export interface Tab<TData> {
	id: string;
	titleOverride?: string;
	createdAt: number;
	activePaneId: string | null;
	layout: LayoutNode;
	panes: Record<string, Pane<TData>>;
}

export interface WorkspaceState<TData> {
	version: 1;
	tabs: Tab<TData>[];
	activeTabId: string | null;
}
