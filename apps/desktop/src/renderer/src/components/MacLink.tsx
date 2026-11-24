import { useCallback, useEffect, useState } from "react";
import type { MacLinkStatusDTO } from "../../../shared/host";
import { Button } from "./ui/button";

// Settings → Boxes: whether this Mac's tasks and its boxes' reach each other
// (main/mac-link.ts). Turned on, this Mac joins the links of each box it holds:
// agents here list and message the tasks there, and the agents and the Lead on
// a box list and message the tasks here, while Ateam is open. Below, each box.

const IPC_PREFIX = /^Error invoking remote method '[^']+': (Error: )?/;
const errorText = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).replace(IPC_PREFIX, "");

/** How often the boxes are read again while it is on: they link as they connect. */
const REFRESH_MS = 5_000;

export function MacLink({
	confirm,
}: {
	confirm: (title: string, body: string) => Promise<boolean>;
}) {
	const [status, setStatus] = useState<MacLinkStatusDTO | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setStatus(await window.ateamHost.macLinkStatus());
		} catch (e) {
			setError(errorText(e));
		}
	}, []);

	useEffect(() => {
		void load();
		if (!status?.on) return;
		const timer = setInterval(() => void load(), REFRESH_MS);
		return () => clearInterval(timer);
	}, [load, status?.on]);

	const turn = async (on: boolean) => {
		if (on) {
			const ok = await confirm(
				"Let this Mac and your boxes reach each other?",
				"While Ateam is open, an agent or a Lead on any box this Mac holds can list every task on this Mac, in every project, read what its agent last said, and message it. Agents here can do the same with the tasks on those boxes. A box can only read the board and send messages: it can't use this Mac's terminals or git, or answer a question for you. Turn this off to take it down.",
			);
			if (!ok) return;
		}
		setBusy(true);
		setError(null);
		try {
			setStatus(await window.ateamHost.macLinkSet(on));
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="box-card" aria-label="This Mac and your boxes reach each other">
			<div className="box-card-head">
				<div className="box-card-text">
					<div className="box-card-title">This Mac and your boxes reach each other</div>
					<div className="gh-access-muted">
						Agents here see and message the tasks on your boxes, and agents and Leads there see and
						message the tasks here, while Ateam is open. A box only reads the board and sends
						messages.
					</div>
				</div>
				<div className="box-card-actions">
					{busy ? (
						<span className="gh-access-muted">{status?.on ? "Taking it down…" : "Linking…"}</span>
					) : status ? (
						<Button size="xs" variant="outline" onClick={() => void turn(!status.on)}>
							{status.on ? "Turn off" : "Turn on"}
						</Button>
					) : null}
				</div>
			</div>
			{error ? <div className="gh-access-problem">{error}</div> : null}
			{status?.on ? (
				<div className="box-card-section">
					<div className="box-card-label">Boxes that see this Mac as {status.name}</div>
					<ul className="box-devices">
						{status.boxes.map((b) => (
							<li key={b.alias}>
								<span>{b.alias}</span>
								<span className={b.problem ? "gh-access-problem" : "gh-access-muted"}>
									{b.linked ? "linked" : (b.problem ?? "linking…")}
								</span>
							</li>
						))}
						{status.boxes.length === 0 ? (
							<li>
								<span className="gh-access-muted">No box is connected right now.</span>
							</li>
						) : null}
					</ul>
				</div>
			) : null}
		</section>
	);
}
