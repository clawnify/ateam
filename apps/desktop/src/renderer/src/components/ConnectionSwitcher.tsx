import type { ConnectionDTO, SystemInfo } from "@ateam/protocol";
import { AlertCircle, Check, Laptop, Loader2, RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Which engine drives the app: this Mac (local, in-process) or a remote box over
// SSH — over Tailscale, that's the "online ateam" connection. The whole backend
// seam (window.ateamHost) is already wired in main; this is its faucet in the UI.
// Lists ~/.ssh/config hosts so onboarding is just "add a Host entry, then pick it".

const POP_W = 280;

type HostStatus = { mode: "local" | "remote"; alias: string | null; info: SystemInfo };

// "local" is the sentinel for the in-process engine (connect(null)).
type Target = string | "local";

function ago(ms: number | null): string | null {
	if (!ms) return null;
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 60) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

export function ConnectionSwitcher({ onChanged }: { onChanged?: (status: HostStatus) => void }) {
	const [current, setCurrent] = useState<HostStatus | null>(null);
	const [conns, setConns] = useState<ConnectionDTO[]>([]);
	const [connecting, setConnecting] = useState<Target | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	const btnRef = useRef<HTMLButtonElement>(null);
	const popRef = useRef<HTMLDivElement>(null);

	const refresh = useCallback(async () => {
		const [cur, list] = await Promise.all([
			window.ateamHost.current(),
			window.ateamHost.list(),
		]);
		setCurrent(cur);
		setConns(list);
	}, []);

	// Keep the button label live even when another window switches the engine.
	useEffect(() => {
		void refresh();
		return window.ateamHost.onChanged((status) => {
			setCurrent(status);
			void window.ateamHost.list().then(setConns);
		});
	}, [refresh]);

	const close = () => setPos(null);
	const open = () => {
		const r = btnRef.current?.getBoundingClientRect();
		if (!r) return;
		let left = Math.min(r.left, window.innerWidth - POP_W - 8);
		left = Math.max(8, left);
		setPos({ top: r.bottom + 6, left });
		setError(null);
		void refresh();
	};

	useEffect(() => {
		if (!pos) return;
		const onDoc = (e: MouseEvent) => {
			const t = e.target as Node;
			if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
			close();
		};
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [pos]);

	const pick = async (target: Target) => {
		// Already there — just close.
		const isActive =
			target === "local" ? current?.mode === "local" : current?.alias === target;
		if (isActive) {
			close();
			return;
		}
		setConnecting(target);
		setError(null);
		try {
			const status = await window.ateamHost.connect(target === "local" ? null : target);
			setCurrent(status);
			onChanged?.(status);
			close();
		} catch (e) {
			// Surface the real reason (box unreachable, daemon not running, protocol
			// mismatch) — the main-process connect() throws a descriptive message.
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setConnecting(null);
		}
	};

	const remote = current?.mode === "remote";
	const label = remote ? (current?.alias ?? "remote") : "Local";

	return (
		<>
			<button
				type="button"
				ref={btnRef}
				className="navbtn conn-btn"
				title="Which machine runs your agents"
				onClick={() => (pos ? close() : open())}
			>
				{remote ? <Server size={14} strokeWidth={1.75} /> : <Laptop size={14} strokeWidth={1.75} />}
				<span>{label}</span>
				<span className={`conn-dot ${remote ? "on" : ""}`} />
			</button>
			{pos &&
				createPortal(
					<div
						ref={popRef}
						className="menu-pop conn-pop"
						style={{ position: "fixed", top: pos.top, left: pos.left, width: POP_W, zIndex: 1000 }}
					>
						<div className="conn-head">
							<span>Run agents on</span>
							<button type="button" className="conn-refresh" title="Rescan ~/.ssh/config" onClick={() => void refresh()}>
								<RefreshCw size={12} strokeWidth={2} />
							</button>
						</div>

						{/* Local engine */}
						<ConnRow
							icon={<Laptop size={15} strokeWidth={1.75} />}
							title="This Mac"
							subtitle="Runs locally, no connection"
							active={current?.mode === "local"}
							busy={connecting === "local"}
							onClick={() => void pick("local")}
						/>

						<div className="conn-sep" />

						{conns.length === 0 ? (
							<div className="conn-empty">
								No servers in <code>~/.ssh/config</code>.
								<br />
								Add a <code>Host</code> entry for your box to connect.
							</div>
						) : (
							conns.map((c) => {
								const seen = ago(c.lastSeen);
								const sub = c.hostName
									? c.known && seen
										? `${c.hostName} · seen ${seen}`
										: c.hostName
									: c.known
										? "saved host (not in ssh config)"
										: "unknown host";
								return (
									<ConnRow
										key={c.alias}
										icon={<Server size={15} strokeWidth={1.75} />}
										title={c.alias}
										subtitle={sub}
										active={current?.mode === "remote" && current.alias === c.alias}
										busy={connecting === c.alias}
										onClick={() => void pick(c.alias)}
									/>
								);
							})
						)}

						{error && (
							<div className="conn-error">
								<AlertCircle size={13} strokeWidth={2} />
								<span>{error}</span>
							</div>
						)}
					</div>,
					document.body,
				)}
		</>
	);
}

function ConnRow({
	icon,
	title,
	subtitle,
	active,
	busy,
	onClick,
}: {
	icon: React.ReactNode;
	title: string;
	subtitle: string;
	active: boolean;
	busy: boolean;
	onClick: () => void;
}) {
	return (
		<button type="button" className={`conn-row ${active ? "active" : ""}`} onClick={onClick} disabled={busy}>
			<span className="conn-ico">{icon}</span>
			<span className="conn-txt">
				<span className="conn-title">{title}</span>
				<span className="conn-sub">{subtitle}</span>
			</span>
			{busy ? (
				<Loader2 size={15} strokeWidth={2} className="conn-spin" />
			) : active ? (
				<Check size={15} strokeWidth={2.25} />
			) : null}
		</button>
	);
}
