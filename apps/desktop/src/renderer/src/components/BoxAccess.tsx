import type { PairingInviteDTO, PairingStatusDTO } from "@ateam/protocol";
import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import { Button } from "./ui/button";

// Settings → Boxes, Access: who may use a box over its network port (pairing,
// protocol v29). An open box serves anyone who can reach that port, which on a
// default Tailscale network is every device on it; a locked one serves only the
// devices paired with it. SSH is never affected. A phone pairs from here: the QR
// holds an `ateamgo://pair` link the iPhone's Camera opens in Ateam Go.

const IPC_PREFIX = /^Error invoking remote method '[^']+': (Error: )?/;
const errorText = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).replace(IPC_PREFIX, "");

const shownCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export function BoxAccess({
	alias,
	title,
	confirm,
}: {
	alias: string;
	title: string;
	confirm: (title: string, body: string) => Promise<boolean>;
}) {
	const [status, setStatus] = useState<PairingStatusDTO | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [invite, setInvite] = useState<(PairingInviteDTO & { link: string | null }) | null>(null);
	const [qr, setQr] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setStatus(await window.ateamHost.pairingStatus(alias));
			setError(null);
		} catch (e) {
			setError(errorText(e));
		}
	}, [alias]);
	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		if (!invite?.link) {
			setQr(null);
			return;
		}
		let live = true;
		void QRCode.toDataURL(invite.link, { margin: 1, width: 180 }).then(
			(url) => live && setQr(url),
			() => live && setQr(null),
		);
		return () => {
			live = false;
		};
	}, [invite]);

	// While a code is on screen, watch for the device that redeems it: the list
	// shows it, and the code goes away (it works once).
	useEffect(() => {
		if (!invite) return;
		const before = status?.devices.length ?? 0;
		const timer = setInterval(() => {
			void window.ateamHost.pairingStatus(alias).then(
				(next) => {
					setStatus(next);
					if (next.devices.length > before) setInvite(null);
				},
				() => {},
			);
		}, 2000);
		return () => clearInterval(timer);
	}, [invite, alias, status?.devices.length]);

	const run = async (work: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await work();
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	const lock = async () => {
		const ok = await confirm(
			`Lock ${title} to your devices?`,
			"Only devices paired with it can use it over the network from then on, starting with this Mac. Every other device needs a pairing code first, and a phone needs Ateam Go 1.4 or later to use one. Connections over SSH aren't affected.",
		);
		if (!ok) return;
		await run(async () => setStatus(await window.ateamHost.pairingLock(alias)));
	};
	const revoke = async (id: string, label: string) => {
		const ok = await confirm(
			`Unpair ${label}?`,
			`It can't use ${title} over the network any more, and its connection drops now. It can pair again with a new code.`,
		);
		if (!ok) return;
		await run(async () => setStatus(await window.ateamHost.pairingRevoke(alias, id)));
	};
	const pairPhone = () => run(async () => setInvite(await window.ateamHost.pairingInvite(alias)));

	if (!status) {
		return error ? (
			<div className="gh-access-problem">{error}</div>
		) : (
			<div className="gh-access-muted">Checking who can use it…</div>
		);
	}

	if (!status.locked) {
		return (
			<>
				<div className="box-access-warning">
					Anyone on your Tailscale network can control this box over its network port: open
					terminals, read what agents print, use its GitHub token.
				</div>
				<div className="box-lead-row">
					<span className="gh-access-muted">
						Lock it so only the devices you pair can. SSH isn't affected.
					</span>
					<Button size="xs" variant="outline" disabled={busy} onClick={() => void lock()}>
						Lock it
					</Button>
				</div>
				{error && <div className="gh-access-problem">{error}</div>}
			</>
		);
	}

	return (
		<>
			<div className="gh-access-muted">Locked: only these devices can use it over the network.</div>
			<ul className="box-devices">
				{status.devices.map((d) => (
					<li key={d.id}>
						<span className="box-device-name">
							{d.label}
							{d.id === status.you ? <span className="box-card-tag">This Mac</span> : null}
						</span>
						<span className="gh-access-muted">{d.kind}</span>
						{d.id !== status.you && (
							<Button
								size="xs"
								variant="ghost"
								disabled={busy}
								onClick={() => void revoke(d.id, d.label)}
							>
								Unpair
							</Button>
						)}
					</li>
				))}
			</ul>
			{invite ? (
				<div className="box-pair">
					{qr && <img src={qr} alt="Pairing code" width={180} height={180} />}
					<div>
						<div className="box-pair-code">{shownCode(invite.code)}</div>
						<div className="gh-access-muted">
							{qr
								? "Scan it with the iPhone's Camera to open Ateam Go, or type the code on this box's card there."
								: "Type it on this box's card in Ateam Go."}{" "}
							It works once, for 10 minutes.
						</div>
						<Button size="xs" variant="ghost" onClick={() => setInvite(null)}>
							Done
						</Button>
					</div>
				</div>
			) : (
				<div>
					<Button size="xs" variant="outline" disabled={busy} onClick={() => void pairPhone()}>
						Pair a phone
					</Button>
				</div>
			)}
			{error && <div className="gh-access-problem">{error}</div>}
		</>
	);
}
