import { Check, Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentDTO } from "@ateam/protocol";

// The composer's coding-agent control — the pill + popover the environment picker
// uses, so a *missing* agent on the selected environment can be installed right here
// instead of being a dead "(not installed)" option. Installing asks that environment's
// own engine to run the agent's official installer on itself, which is why the button
// works for this Mac and for a box alike; the one-time OAuth login is a follow-up the
// user runs in a terminal there.

const POP_W = 260;

export function AgentPicker({
	agents,
	value,
	onChange,
	isAvailable,
	alias,
	onInstallAgent,
}: {
	agents: AgentDTO[];
	value: string;
	onChange: (agentId: string) => void;
	isAvailable: (agentId: string) => boolean;
	/** The selected environment — the machine an install lands on. null = this Mac. */
	alias: string | null;
	/** Install the agent on the selected environment; resolves with the login step. */
	onInstallAgent?: (alias: string | null, agentId: string) => Promise<{ loginCommand?: string }>;
}) {
	const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);
	const [installing, setInstalling] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loginFor, setLoginFor] = useState<{ agentId: string; command?: string } | null>(null);
	const btnRef = useRef<HTMLButtonElement>(null);
	const popRef = useRef<HTMLDivElement>(null);

	const current = agents.find((a) => a.id === value);
	const label = current?.label ?? value;

	const close = () => setPos(null);
	const open = () => {
		const r = btnRef.current?.getBoundingClientRect();
		if (!r) return;
		const left = Math.max(8, Math.min(r.left, window.innerWidth - POP_W - 8));
		setPos({ bottom: window.innerHeight - r.top + 6, left });
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
	const install = async (agentId: string) => {
		if (!onInstallAgent || installing) return;
		setInstalling(agentId);
		setError(null);
		setLoginFor(null);
		try {
			const res = await onInstallAgent(alias, agentId);
			// The caller has already recorded the engine's own verdict; select it now.
			onChange(agentId);
			setLoginFor({ agentId, command: res.loginCommand });
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setInstalling(null);
		}
	};

	return (
		<>
			<button
				type="button"
				ref={btnRef}
				className="navbtn conn-btn"
				title="Coding agent"
				onClick={() => (pos ? close() : open())}
			>
				<span>{label}</span>
				{!isAvailable(value) ? <span className="agent-missing">not installed</span> : null}
			</button>
			{pos &&
				createPortal(
					<div
						ref={popRef}
						className="menu-pop conn-pop"
						style={{
							position: "fixed",
							top: "auto",
							right: "auto",
							bottom: pos.bottom,
							left: pos.left,
							width: POP_W,
							maxHeight: "min(70vh, 460px)",
							overflowY: "auto",
							zIndex: 2000,
						}}
					>
						<div className="conn-head">
							<span>Coding agent</span>
						</div>
						{agents.map((a) => {
							const avail = isAvailable(a.id);
							const canInstall = !avail && !!onInstallAgent;
							return (
								<div key={a.id} className="agent-item">
									<div className="agent-row">
										<button
											type="button"
											className={`conn-row ${a.id === value ? "active" : ""}`}
											disabled={!avail}
											onClick={() => {
												if (!avail) return;
												onChange(a.id);
												close();
											}}
										>
											<span className="conn-txt">
												<span className="conn-title">{a.label}</span>
												{!avail ? (
													<span className="conn-sub">
														{alias === null
															? "not installed on this Mac"
															: "not installed on this box"}
													</span>
												) : null}
											</span>
											{a.id === value && avail ? <Check size={15} strokeWidth={2.25} /> : null}
										</button>
										{canInstall ? (
											<button
												type="button"
												className="agent-install-btn"
												disabled={installing !== null}
												onClick={() => void install(a.id)}
											>
												<Download size={13} strokeWidth={1.75} />
												{installing === a.id ? "Installing…" : "Install"}
											</button>
										) : null}
									</div>
									{loginFor?.agentId === a.id ? (
										<div className="agent-login">Installed ✓ — it signs in on first use.</div>
									) : null}
								</div>
							);
						})}
						{error ? <div className="agent-error">{error}</div> : null}
					</div>,
					document.body,
				)}
		</>
	);
}
