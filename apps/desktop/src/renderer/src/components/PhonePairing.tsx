import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import type { PhonePairing, PhonePairingBox } from "../../../shared/host";
import type { BoxRow } from "../boxes-settings";
import { Button } from "./ui/button";

// Settings → Boxes → Pair your iPhone: one QR that puts every box this Mac holds on
// Ateam Go, which is how a phone starts when there's a Mac. A locked box goes in with
// a fresh code, an open one by its address alone (Host.phonePairing). Each box's own
// page still has Pair a phone, for adding a phone to that box alone.

const IPC_PREFIX = /^Error invoking remote method '[^']+': (Error: )?/;
const errorText = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).replace(IPC_PREFIX, "");

function stateLine(box: PhonePairingBox | undefined): string {
	switch (box?.state) {
		case "locked":
			return "Goes on the phone, paired with a code of its own";
		case "open":
			return "Goes on the phone by its address: it's open, so it needs no code";
		case "noPort":
			return "Not reachable from a phone: set up phone access on its page";
		case "failed":
			return "Didn't answer, so it isn't in the code";
		default:
			return "Not connected right now, so it isn't in the code";
	}
}

export function PhonePairingPage({
	rows,
	onOpenBox,
}: {
	rows: BoxRow[];
	onOpenBox: (alias: string) => void;
}) {
	const [pairing, setPairing] = useState<PhonePairing | null>(null);
	const [qr, setQr] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [now, setNow] = useState(Date.now());

	const make = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			setPairing(await window.ateamHost.phonePairing());
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	}, []);
	useEffect(() => {
		void make();
	}, [make]);

	useEffect(() => {
		if (!pairing?.link) {
			setQr(null);
			return;
		}
		let live = true;
		void QRCode.toDataURL(pairing.link, { margin: 1, width: 200 }).then(
			(url) => live && setQr(url),
			() => live && setQr(null),
		);
		return () => {
			live = false;
		};
	}, [pairing]);

	// The codes in it run out: say so when they have, rather than show a dead code.
	useEffect(() => {
		if (!pairing?.expiresAt) return;
		const t = setInterval(() => setNow(Date.now()), 5_000);
		return () => clearInterval(t);
	}, [pairing]);
	const expired = pairing?.expiresAt != null && now >= pairing.expiresAt;

	const byAlias = new Map(pairing?.boxes.map((b) => [b.alias, b]));
	return (
		<div className="boxes-settings">
			<p className="settings-section-intro">
				Scan this with the iPhone's Camera, or with Scan the code in Ateam Go. The boxes marked
				below go on the phone. The phone reaches them over Tailscale, so it needs the Tailscale app,
				signed in to the account your boxes are on.
			</p>
			{pairing === null ? (
				<div className="gh-access-muted">{busy ? "Making the code…" : null}</div>
			) : pairing.link && !expired ? (
				<div className="box-pair">
					{qr && <img src={qr} alt="Code for Ateam Go" width={200} height={200} />}
					<div className="gh-access-muted">
						{pairing.expiresAt
							? "The codes in it work once, for 10 minutes."
							: "It holds no codes, so it doesn't run out."}
					</div>
				</div>
			) : (
				<div className="box-lead-row">
					<span className="gh-access-muted">
						{expired
							? "Its codes ran out."
							: rows.length
								? "None of your boxes can be reached from a phone yet."
								: "Ateam Go reaches boxes, not this Mac. Add a box first, with phone access."}
					</span>
					{expired ? (
						<Button size="xs" variant="outline" disabled={busy} onClick={() => void make()}>
							Make a new code
						</Button>
					) : null}
				</div>
			)}
			{error && <div className="gh-access-problem">{error}</div>}
			{rows.length > 0 ? (
				<ul className="box-devices">
					{rows.map((row) => {
						const box = byAlias.get(row.alias);
						return (
							<li key={row.alias}>
								<span className="box-device-name">{row.title}</span>
								<span className="gh-access-muted" title={box?.error}>
									{pairing ? stateLine(box) : null}
								</span>
								{box?.state === "noPort" ? (
									<Button size="xs" variant="ghost" onClick={() => onOpenBox(row.alias)}>
										Open
									</Button>
								) : null}
							</li>
						);
					})}
				</ul>
			) : null}
		</div>
	);
}
