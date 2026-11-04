import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { boxesNeedingYou, engineLabel } from "../boxes-settings";
import { addTailscaleBox, installBox } from "../lib/box-actions";
import { BoxPage, statusLine, useBoxActions, useBoxes } from "./BoxPage";
import { CrossBox } from "./CrossBox";
import { EnvironmentPicker } from "./EnvironmentPicker";
import { usePrompt } from "./usePrompt";

// Settings → Boxes: every box this Mac has used, one row each, with what is known about
// it (its state, its engine) and a dot when one needs you. A row opens the box's own page
// (BoxPage.tsx): what's left to set it up, its Lead, its Access and its GitHub. A box
// added here opens its page when it's ready. Here too the desktop's Lead chat is moved
// onto a box (client.leadBox, on the box's page), as the phone picks its Lead box in its
// own Boxes, and the boxes are let reach each other (client.crossBox, CrossBox.tsx).
export function BoxesSettings() {
	const { rows, github, canUpdateSsh, load } = useBoxes();
	const { ui: promptUi, confirm } = usePrompt();
	const actions = useBoxActions(load, confirm);
	// The box whose page is open; null shows the list.
	const [page, setPage] = useState<string | null>(null);

	if (rows === null) return <div className="gh-access-muted">Loading boxes…</div>;
	const needing = boxesNeedingYou(rows, github, Date.now());
	const open = page ? rows.find((r) => r.alias === page) : undefined;

	if (open) {
		return (
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
		);
	}

	// The same ways to add a box as New task's Run on picker: create one on Hetzner, set one
	// up over SSH, or connect one on the tailnet (with a code if it's locked). The picker
	// keeps its place in the tree from no boxes to the first, or it would lose its state.
	return (
		<div className="boxes-settings">
			{promptUi}
			<div className="box-lead-row">
				<span className="gh-access-muted">
					{rows.length === 0 ? "No boxes yet." : "Machines that run your agents."}
				</span>
				<EnvironmentPicker
					addOnly
					environments={[]}
					value={null}
					onChange={() => {}}
					onAdd={addTailscaleBox}
					onInstall={installBox}
					onSetUp={setPage}
				/>
			</div>
			{rows.length > 1 ? <CrossBox confirm={confirm} /> : null}
			{rows.length > 0 ? (
				<ul className="box-list">
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
		</div>
	);
}
