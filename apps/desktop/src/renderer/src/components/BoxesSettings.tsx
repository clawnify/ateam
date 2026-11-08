import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { boxesNeedingYou, engineLabel } from "../boxes-settings";
import { addTailscaleBox, installBox } from "../lib/box-actions";
import { useSetups } from "../lib/setups";
import { BoxPage, BoxSetupPage, statusLine, useBoxActions, useBoxes } from "./BoxPage";
import { CrossBox } from "./CrossBox";
import { DotfilesDefault } from "./Dotfiles";
import { EnvironmentPicker } from "./EnvironmentPicker";
import { PhonePairingPage } from "./PhonePairing";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "./ui/breadcrumb";
import { Button } from "./ui/button";
import { usePrompt } from "./usePrompt";

/** Pair your iPhone's page: no box alias is this (they're ssh aliases or host:port). */
const PHONE_PAGE = "\0phone";

// Settings → Boxes: every box this Mac has used, one row each, with what is known about
// it (its state, its engine) and a dot when one needs you. A row opens the box's own page
// (BoxPage.tsx): what's left to set it up, its Lead, its Access and its GitHub. A box
// added here opens its page when it's ready. Here too the desktop's Lead chat is moved
// onto a box (client.leadBox, on the box's page), as the phone picks its Lead box in its
// own Boxes, and the boxes are let reach each other (client.crossBox, CrossBox.tsx).
// It heads its own section: the list has the section's title and what it's for, a box's
// page has crumbs back to the list in their place.
export function BoxesSettings({ title, intro }: { title: string; intro?: string }) {
	const { rows, github, canUpdateSsh, load } = useBoxes();
	const { ui: promptUi, confirm } = usePrompt();
	const actions = useBoxActions(load, confirm);
	// The box whose page is open; null shows the list, PHONE_PAGE Pair your iPhone.
	const [page, setPage] = useState<string | null>(null);
	const setups = useSetups();

	const heading = (
		<>
			<h3>{title}</h3>
			{intro ? <p className="settings-section-intro">{intro}</p> : null}
		</>
	);
	const crumbs = (name: string) => (
		<Breadcrumb className="settings-crumbs">
			<BreadcrumbList>
				<BreadcrumbItem>
					<BreadcrumbLink asChild>
						<button type="button" className="settings-crumb-link" onClick={() => setPage(null)}>
							{title}
						</button>
					</BreadcrumbLink>
				</BreadcrumbItem>
				<BreadcrumbSeparator />
				<BreadcrumbItem>
					<BreadcrumbPage>{name}</BreadcrumbPage>
				</BreadcrumbItem>
			</BreadcrumbList>
		</Breadcrumb>
	);

	if (rows === null) {
		return (
			<>
				{heading}
				<div className="gh-access-muted">Loading boxes…</div>
			</>
		);
	}
	const needing = boxesNeedingYou(rows, github, Date.now());
	const open = page ? rows.find((r) => r.alias === page) : undefined;
	// Boxes being set up that aren't boxes yet: a row each, and a page.
	const pending = setups.filter((s) => !rows.some((r) => r.alias === s.dest));
	const openSetup = page && !open ? pending.find((s) => s.dest === page) : undefined;

	if (page === PHONE_PAGE) {
		return (
			<>
				{crumbs("Pair your iPhone")}
				<PhonePairingPage rows={rows} onOpenBox={setPage} />
			</>
		);
	}

	if (openSetup) {
		return (
			<>
				{crumbs(openSetup.dest)}
				<div className="boxes-settings">
					{promptUi}
					<BoxSetupPage setup={openSetup} onBack={() => setPage(null)} />
				</div>
			</>
		);
	}

	if (open) {
		return (
			<>
				{crumbs(open.title)}
				<div className="boxes-settings">
					{promptUi}
					<BoxPage
						row={open}
						access={github[open.alias]}
						needsYou={needing.has(open.alias)}
						canUpdateSsh={canUpdateSsh}
						actions={actions}
						confirm={confirm}
						onBack={() => setPage(null)}
					/>
				</div>
			</>
		);
	}

	// The same ways to add a box as New task's Run on picker: create one on Hetzner, set one
	// up over SSH, or connect one on the tailnet (with a code if it's locked). The picker
	// keeps its place in the tree from no boxes to the first, or it would lose its state.
	return (
		<>
			{heading}
			<div className="boxes-settings">
				{promptUi}
				<div className="box-lead-row">
					<span className="gh-access-muted">
						{rows.length + pending.length === 0
							? "No boxes yet."
							: "Machines that run your agents."}
					</span>
					<span className="box-list-actions">
						<Button size="xs" variant="outline" onClick={() => setPage(PHONE_PAGE)}>
							Pair your iPhone
						</Button>
						<EnvironmentPicker
							addOnly
							environments={[]}
							value={null}
							onChange={() => {}}
							onAdd={addTailscaleBox}
							onInstall={installBox}
							onSetUp={setPage}
						/>
					</span>
				</div>
				{rows.length > 1 ? <CrossBox confirm={confirm} /> : null}
				{rows.length + pending.length > 0 ? (
					<ul className="box-list">
						{pending.map((s) => (
							<li key={`setup:${s.dest}`}>
								<button type="button" className="box-row" onClick={() => setPage(s.dest)}>
									<span className="box-card-text">
										<span className="box-card-title">{s.dest}</span>
										<span className="box-card-status">
											{s.state === "failed"
												? "Couldn't set it up"
												: s.state === "done"
													? "Set up, connecting…"
													: "Setting up over SSH…"}
										</span>
									</span>
									<ChevronRight size={16} strokeWidth={1.75} className="box-row-chevron" />
								</button>
							</li>
						))}
						{rows.map((row) => (
							<li key={row.alias}>
								<button type="button" className="box-row" onClick={() => setPage(row.alias)}>
									<span className="box-card-text">
										<span className="box-card-title">
											{row.title}
											{actions.leadBox === row.alias ? (
												<span className="box-card-tag">Lead</span>
											) : null}
											{needing.has(row.alias) ? (
												<span className="box-card-dot" role="img" aria-label="needs you" />
											) : null}
										</span>
										<span className="box-card-detail">{row.detail}</span>
										<span className="box-card-status">
											<span className={`box-card-state ${row.state}`}>
												{actions.busy[row.alias] ?? statusLine(row, Date.now())}
											</span>
											{" · "}
											<span className={row.engine === "behind" ? "box-card-behind" : undefined}>
												{engineLabel(row)}
											</span>
										</span>
									</span>
									<ChevronRight size={16} strokeWidth={1.75} className="box-row-chevron" />
								</button>
							</li>
						))}
					</ul>
				) : null}
				<DotfilesDefault />
			</div>
		</>
	);
}
