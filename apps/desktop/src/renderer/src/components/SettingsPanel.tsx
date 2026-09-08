import type {
	AgentDTO,
	AteamSettings,
	MergeStrategy,
	SettingsPatch,
	SettingsResult,
	UpdateStrategy,
} from "@ateam/protocol";
import { AlertTriangle, Search } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

/**
 * The settings page: a section list on the left, rows of title + description +
 * control on the right, and a search box that filters rows across every
 * section (the shape Cursor and VS Code settled on, because it scales to
 * hundreds of rows without a redesign).
 *
 * Every row is data, not JSX: a title, a description, where its value lives in
 * the file, and a control. That is what makes search possible, and it keeps a
 * new setting to one entry in `ROWS` rather than a hand-built block.
 *
 * Values are written as they change — a settings page has no Save button
 * worth explaining — straight to `~/.ateam/settings.json` on the machine that
 * answers (this Mac, or the box you have selected). Only keys with a reader are
 * offered: a setting nothing acts on is a lie, however tidy the row.
 */

type SectionId = "general" | "agents" | "git";

const SECTIONS: { id: SectionId; label: string }[] = [
	{ id: "general", label: "General" },
	{ id: "agents", label: "Agents" },
	{ id: "git", label: "Git" },
];

interface Row {
	id: string;
	section: SectionId;
	title: string;
	description: string;
	control: (settings: AteamSettings, ctx: RowContext) => ReactNode;
}

interface RowContext {
	agents: AgentDTO[];
	patch: (p: SettingsPatch) => void;
}

const MERGE_STRATEGIES: { value: MergeStrategy; label: string }[] = [
	{ value: "squash", label: "Squash" },
	{ value: "merge", label: "Merge commit" },
	{ value: "rebase", label: "Rebase" },
];
const UPDATE_STRATEGIES: { value: UpdateStrategy; label: string }[] = [
	{ value: "merge", label: "Merge" },
	{ value: "rebase", label: "Rebase" },
];

const ROWS: Row[] = [
	{
		id: "client.autoDownloadUpdates",
		section: "general",
		title: "Download updates automatically",
		description:
			"Fetch a new version in the background and ask only when it is ready to restart. Off: ask before downloading.",
		control: (s, { patch }) => (
			<Switch
				checked={s.client.autoDownloadUpdates}
				label="Download updates automatically"
				onChange={(v) => patch({ client: { autoDownloadUpdates: v } })}
			/>
		),
	},
	{
		id: "engine.defaultAgentId",
		section: "agents",
		title: "Default agent",
		description: "The agent a new task or loop launches with when you don't pick one.",
		control: (s, { agents, patch }) => (
			<select
				className="settings-select"
				value={s.engine.defaultAgentId}
				onChange={(e) => patch({ engine: { defaultAgentId: e.target.value } })}
			>
				{agents.map((a) => (
					<option key={a.id} value={a.id}>
						{a.label}
						{a.available ? "" : " (not installed)"}
					</option>
				))}
			</select>
		),
	},
	{
		id: "engine.defaultMergeStrategy",
		section: "git",
		title: "Merge strategy",
		description: "How “Merge via PR” lands a task's branch on its base.",
		control: (s, { patch }) => (
			<select
				className="settings-select"
				value={s.engine.defaultMergeStrategy}
				onChange={(e) =>
					patch({ engine: { defaultMergeStrategy: e.target.value as MergeStrategy } })
				}
			>
				{MERGE_STRATEGIES.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
		),
	},
	{
		id: "engine.defaultUpdateStrategy",
		section: "git",
		title: "Update from base",
		description: "How “Update from base branch” brings the base into a task's branch.",
		control: (s, { patch }) => (
			<select
				className="settings-select"
				value={s.engine.defaultUpdateStrategy}
				onChange={(e) =>
					patch({ engine: { defaultUpdateStrategy: e.target.value as UpdateStrategy } })
				}
			>
				{UPDATE_STRATEGIES.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
		),
	},
	{
		id: "engine.deleteRemoteBranchOnMerge",
		section: "git",
		title: "Delete the remote branch after merging",
		description: "Once a task's PR has merged, remove its branch from origin.",
		control: (s, { patch }) => (
			<Switch
				checked={s.engine.deleteRemoteBranchOnMerge}
				label="Delete the remote branch after merging"
				onChange={(v) => patch({ engine: { deleteRemoteBranchOnMerge: v } })}
			/>
		),
	},
];

function Switch({
	checked,
	label,
	onChange,
}: {
	checked: boolean;
	label: string;
	onChange: (v: boolean) => void;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			className={`settings-switch ${checked ? "on" : ""}`}
			onClick={() => onChange(!checked)}
		>
			<span className="settings-switch-knob" />
		</button>
	);
}

export function SettingsPanel({ agents }: { agents: AgentDTO[] }) {
	const [result, setResult] = useState<SettingsResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const searchRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		let cancelled = false;
		window.ateam.settings
			.get()
			.then((r) => {
				if (!cancelled) setResult(r);
			})
			.catch((e) => setError(String(e)));
		return () => {
			cancelled = true;
		};
	}, []);

	// Optimistic: the row reflects the change at once, the file catches up, and
	// a failed write puts the true state back with the reason on screen.
	const patch = useCallback((p: SettingsPatch) => {
		setResult((cur) =>
			cur
				? {
						...cur,
						settings: {
							...cur.settings,
							client: { ...cur.settings.client, ...p.client },
							engine: { ...cur.settings.engine, ...p.engine },
						},
					}
				: cur,
		);
		window.ateam.settings
			.update(p)
			.then(setResult)
			.catch((e) => {
				setError(String(e));
				void window.ateam.settings.get().then(setResult);
			});
	}, []);

	// ⌘F is "search settings" here, the way it is in every settings page a Mac
	// user has met — the terminal is not on this screen to want it.
	const onKeys = (e: React.KeyboardEvent) => {
		if ((e.metaKey || e.ctrlKey) && e.key === "f") {
			e.preventDefault();
			searchRef.current?.focus();
			searchRef.current?.select();
		}
	};

	const q = query.trim().toLowerCase();
	const visible = q
		? ROWS.filter((r) => `${r.title} ${r.description}`.toLowerCase().includes(q))
		: ROWS;
	const jump = (id: SectionId) => {
		document.getElementById(`settings-${id}`)?.scrollIntoView({ block: "start" });
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the shortcut applies to the page, not to one control
		<div className="settings" onKeyDown={onKeys}>
			<nav className="settings-nav" aria-label="Settings sections">
				<label className="settings-search">
					<Search size={14} strokeWidth={1.75} />
					<input
						ref={searchRef}
						type="search"
						placeholder="Search ⌘F"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
				</label>
				{SECTIONS.map((s) => (
					<button
						type="button"
						key={s.id}
						className="navbtn settings-nav-item"
						disabled={q !== "" && !visible.some((r) => r.section === s.id)}
						onClick={() => jump(s.id)}
					>
						{s.label}
					</button>
				))}
			</nav>

			<div className="settings-body">
				{error && (
					<div className="settings-warning">
						<AlertTriangle size={14} strokeWidth={1.75} />
						<span>{error}</span>
					</div>
				)}
				{result?.warning && (
					<div className="settings-warning">
						<AlertTriangle size={14} strokeWidth={1.75} />
						<span>{result.warning}</span>
					</div>
				)}
				{!result ? (
					<div className="empty">Loading settings…</div>
				) : visible.length === 0 ? (
					<div className="empty">No settings match “{query}”.</div>
				) : (
					SECTIONS.map((section) => {
						const rows = visible.filter((r) => r.section === section.id);
						if (rows.length === 0) return null;
						return (
							<section key={section.id} id={`settings-${section.id}`} className="settings-section">
								<h3>{section.label}</h3>
								<div className="settings-group">
									{rows.map((row) => (
										<div key={row.id} className="settings-row">
											<div className="settings-row-text">
												<div className="settings-row-title">{row.title}</div>
												<div className="settings-row-desc">{row.description}</div>
											</div>
											<div className="settings-row-control">
												{row.control(result.settings, { agents, patch })}
											</div>
										</div>
									))}
								</div>
							</section>
						);
					})
				)}
				{result && (
					<p className="settings-foot">
						Stored in <code>{result.path}</code> on the machine you have selected. Edit it by hand
						if you like; changes apply on the next read.
					</p>
				)}
			</div>
		</div>
	);
}
