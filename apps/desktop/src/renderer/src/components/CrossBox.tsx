import type { BoxLinkDTO } from "@ateam/protocol";
import { useCallback, useEffect, useState } from "react";
import type { CrossBoxStatusDTO } from "../../../shared/host";
import { Button } from "./ui/button";

// Settings → Boxes: whether the boxes reach each other (cross-box, main/cross-box.ts).
// Turned on, each box gets a link to the others, paired on each one like a device,
// that reads the board and sends messages: its agents list and message the tasks
// there, and a Lead on a box sees them all. Below, each box's links as they are.

const IPC_PREFIX = /^Error invoking remote method '[^']+': (Error: )?/;
const errorText = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).replace(IPC_PREFIX, "");

/** How often the links are read again while they are on: they connect on their own. */
const REFRESH_MS = 5_000;

function linkLine(l: BoxLinkDTO): string {
	switch (l.state) {
		case "connected":
			return l.name;
		case "connecting":
			return `${l.name} (connecting)`;
		case "refused":
			return `${l.name} (refused${l.reason ? `: ${l.reason}` : ""})`;
		default:
			return `${l.name} (can't reach it${l.reason ? `: ${l.reason}` : ""})`;
	}
}

export function CrossBox({
	confirm,
}: {
	confirm: (title: string, body: string) => Promise<boolean>;
}) {
	const [status, setStatus] = useState<CrossBoxStatusDTO | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setStatus(await window.ateamHost.crossBoxStatus());
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
				"Let your boxes reach each other?",
				"Each box this Mac holds gets a link to the others, paired on each one like a device. An agent on any of them can then list the tasks on the others and message them, and a Lead that runs on a box sees them all. A link can only read the board and send messages: it can't use terminals or git. Turn this off to take the links down.",
			);
			if (!ok) return;
		}
		setBusy(true);
		setError(null);
		try {
			setStatus(await window.ateamHost.crossBoxSet(on));
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="box-card" aria-label="Boxes reach each other">
			<div className="box-card-head">
				<div className="box-card-text">
					<div className="box-card-title">Boxes reach each other</div>
					<div className="gh-access-muted">
						Agents on one box see and message the tasks on the others, and a Lead on a box sees them
						all. A link only reads the board and sends messages.
					</div>
				</div>
				<div className="box-card-actions">
					{busy ? (
						<span className="gh-access-muted">
							{status?.on ? "Taking links down…" : "Linking…"}
						</span>
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
					<div className="box-card-label">Links</div>
					<ul className="box-devices">
						{status.boxes.map((b) => (
							<li key={b.alias}>
								<span>{b.alias}</span>
								<span className={b.problem ? "gh-access-problem" : "gh-access-muted"}>
									{b.links.length > 0
										? `reaches ${b.links.map(linkLine).join(", ")}`
										: b.problem
											? ""
											: "no links yet"}
									{b.problem ? `${b.links.length > 0 ? ". " : ""}${b.problem}` : ""}
								</span>
							</li>
						))}
					</ul>
				</div>
			) : null}
		</section>
	);
}
