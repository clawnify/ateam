import { Check, Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentDTO } from "@ateam/protocol";

// The composer's coding-agent control — the pill + popover the environment picker
// uses, so a *missing* agent on the selected box can be installed right here instead
// of being a dead "(not installed)" option. Installing runs the agent's official
// installer on the box over SSH (streamed); the one-time OAuth login is a follow-up
// the user runs in the box's terminal.

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
	/** The selected environment — install targets this box; null (local) can't install. */
	alias: string | null;
	/** Install an agent on the box, streaming log lines; resolves with the login step. */
	onInstallAgent?: (
		alias: string,
		agentId: string,
		onLog: (chunk: string) => void,
	) => Promise<{ loginCommand?: string }>;
}) {
	const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);
	const [installing, setInstalling] = useState<string | null>(null);
	const [log, setLog] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loginFor, setLoginFor] = useState<{ agentId: string; command?: string } | null>(null);
	const btnRef = useRef<HTMLButtonElement>(null);
	const popRef = useRef<HTMLDivElement>(null);
	const logRef = useRef<HTMLPreElement>(null);

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
	useEffect(() => {
		if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
	}, [log]);

	const install = async (agentId: string) => {
		if (!alias || !onInstallAgent || installing) return;
		setInstalling(agentId);
		setError(null);
		setLog("");
		setLoginFor(null);
		try {
			const res = await onInstallAgent(alias, agentId, (chunk) => setLog((l) => l + chunk));
			// The box's agent list refreshes via onConnectionsChanged; select it now.
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
							const canInstall = !avail && alias !== null && !!onInstallAgent;
							return (
								<div key={a.id} className="agent-item">
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
									{installing === a.id && log ? (
										<pre ref={logRef} className="conn-install-log">
											{log}
										</pre>
									) : null}
									{loginFor?.agentId === a.id ? (
										<div className="agent-login">
											Installed ✓ — sign in on the box:{" "}
											<code>{loginFor.command ?? `${a.id} login`}</code>
										</div>
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
