import { Check, Cloud, Download, Laptop, Plus, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CreateBoxDialog } from "./CreateBoxDialog";

// The task's "Run on" control — the pill + popover style the global connection
// switcher used, moved into the New Task dialog. `null` alias = this Mac; a box alias
// runs the task on that VPS (cloning the project there on first use). Disabled
// options (no git remote to clone from) show why they can't be picked.
//
// SSH boxes arrive on their own — they're whatever is in ~/.ssh/config. A Tailscale
// box has no such registry, so it's typed in once here; connecting is what saves it.

const POP_W = 260;

export type EnvOption = {
	alias: string | null;
	label: string;
	disabled: boolean;
	transport?: "ssh" | "ws";
};

export function EnvironmentPicker({
	environments,
	value,
	onChange,
	onAdd,
	onInstall,
}: {
	environments: EnvOption[];
	value: string | null;
	onChange: (alias: string | null) => void;
	/** Connect a Tailscale endpoint (`host:port`); rejects with a message to show. */
	onAdd?: (endpoint: string) => Promise<void>;
	/** Install the engine on a fresh SSH box (`alias` or `user@host`), streaming the
	 *  installer's output; resolves once the box is set up and connected. */
	onInstall?: (dest: string, onLog: (chunk: string) => void) => Promise<void>;
}) {
	const [adding, setAdding] = useState(false);
	const [endpoint, setEndpoint] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);
	// The "Set up a box over SSH" flow: an SSH destination, then a live installer log.
	const [setup, setSetup] = useState(false);
	const [dest, setDest] = useState("");
	const [installing, setInstalling] = useState(false);
	const [log, setLog] = useState("");
	const [installError, setInstallError] = useState<string | null>(null);
	// The "Create a new box" flow opens a modal (too much for the popover).
	const [creating, setCreating] = useState(false);
	const btnRef = useRef<HTMLButtonElement>(null);
	const popRef = useRef<HTMLDivElement>(null);
	const logRef = useRef<HTMLPreElement>(null);

	const isRemote = value !== null;
	const label = environments.find((e) => e.alias === value)?.label ?? "Local";

	const close = () => setPos(null);
	const open = () => {
		const r = btnRef.current?.getBoundingClientRect();
		if (!r) return;
		const left = Math.max(8, Math.min(r.left, window.innerWidth - POP_W - 8));
		// Anchor the popover's BOTTOM just above the button and let it grow UPWARD, so
		// its edge sits next to the toggle no matter how many environments there are
		// (estimating the height and offsetting from the top drifts as the list grows).
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

	const pick = (env: EnvOption) => {
		if (env.disabled) return;
		onChange(env.alias);
		close();
	};

	const submit = async () => {
		const ep = endpoint.trim();
		if (!ep || !onAdd || busy) return;
		setBusy(true);
		setError(null);
		try {
			await onAdd(ep);
			// Connecting is what saves it, so only now is it a real option.
			onChange(ep);
			setEndpoint("");
			setAdding(false);
			close();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	// Keep the streaming installer log pinned to its newest line.
	useEffect(() => {
		if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
	}, [log]);

	const submitInstall = async () => {
		const d = dest.trim();
		if (!d || !onInstall || installing) return;
		setInstalling(true);
		setInstallError(null);
		setLog("");
		try {
			await onInstall(d, (chunk) => setLog((prev) => prev + chunk));
			// install() sets the box up AND connects it — select it and close.
			onChange(d);
			setDest("");
			setSetup(false);
			close();
		} catch (err) {
			setInstallError(err instanceof Error ? err.message : String(err));
		} finally {
			setInstalling(false);
		}
	};

	return (
		<>
			<button
				type="button"
				ref={btnRef}
				className="navbtn conn-btn"
				title="Run on — which machine runs this task"
				onClick={() => (pos ? close() : open())}
			>
				{isRemote ? (
					<Server size={14} strokeWidth={1.75} />
				) : (
					<Laptop size={14} strokeWidth={1.75} />
				)}
				<span>{label}</span>
				<span className={`conn-dot ${isRemote ? "on" : ""}`} />
			</button>
			{pos &&
				createPortal(
					<div
						ref={popRef}
						className="menu-pop conn-pop"
						style={{
							position: "fixed",
							// Cancel .menu-pop's `top: calc(100% + 4px)` / `right: 0` — we anchor
							// by the bottom-left instead, and a leftover `top` would push it off-screen.
							top: "auto",
							right: "auto",
							bottom: pos.bottom,
							left: pos.left,
							width: POP_W,
							maxHeight: "min(70vh, 420px)",
							overflowY: "auto",
							zIndex: 2000,
						}}
					>
						<div className="conn-head">
							<span>Run on</span>
						</div>
						{environments.map((env) => (
							<button
								key={env.label}
								type="button"
								className={`conn-row ${env.alias === value ? "active" : ""}`}
								disabled={env.disabled}
								onClick={() => pick(env)}
							>
								<span className="conn-ico">
									{env.alias === null ? (
										<Laptop size={15} strokeWidth={1.75} />
									) : (
										<Server size={15} strokeWidth={1.75} />
									)}
								</span>
								<span className="conn-txt">
									<span className="conn-title">{env.label}</span>
									{env.disabled && env.alias !== null ? (
										<span className="conn-sub">no git remote to clone</span>
									) : env.transport === "ws" ? (
										<span className="conn-sub">Tailscale</span>
									) : null}
								</span>
								{env.alias === value ? <Check size={15} strokeWidth={2.25} /> : null}
							</button>
						))}
						{onAdd &&
							(adding ? (
								<div className="conn-add">
									<input
										// biome-ignore lint/a11y/noAutofocus: the row was just clicked to reveal this
										autoFocus
										className="conn-add-input"
										placeholder="100.x.y.z:8787"
										aria-label="Tailscale address and port"
										value={endpoint}
										disabled={busy}
										onChange={(e) => setEndpoint(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") void submit();
											if (e.key === "Escape") {
												setAdding(false);
												setError(null);
											}
										}}
									/>
									<span className="conn-sub">
										{busy ? "Connecting…" : (error ?? "The box's Tailscale address")}
									</span>
								</div>
							) : (
								<button
									type="button"
									className="conn-row"
									onClick={() => {
										setAdding(true);
										setError(null);
									}}
								>
									<span className="conn-ico">
										<Plus size={15} strokeWidth={1.75} />
									</span>
									<span className="conn-txt">
										<span className="conn-title">Add a Tailscale box</span>
									</span>
								</button>
							))}
						{onInstall &&
							(setup ? (
								<div className="conn-add">
									<input
										// biome-ignore lint/a11y/noAutofocus: the row was just clicked to reveal this
										autoFocus
										className="conn-add-input"
										placeholder="ssh alias or user@host"
										aria-label="SSH destination to set up"
										value={dest}
										disabled={installing}
										onChange={(e) => setDest(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") void submitInstall();
											if (e.key === "Escape" && !installing) {
												setSetup(false);
												setInstallError(null);
											}
										}}
									/>
									{log && (
										<pre ref={logRef} className="conn-install-log">
											{log}
										</pre>
									)}
									<span className="conn-sub">
										{installing
											? "Setting up the box…"
											: (installError ?? "Installs the engine over SSH, then connects")}
									</span>
									{!installing && (
										<button
											type="button"
											className="conn-install-go"
											onClick={() => void submitInstall()}
										>
											Set up
										</button>
									)}
								</div>
							) : (
								<button
									type="button"
									className="conn-row"
									onClick={() => {
										setSetup(true);
										setInstallError(null);
									}}
								>
									<span className="conn-ico">
										<Download size={15} strokeWidth={1.75} />
									</span>
									<span className="conn-txt">
										<span className="conn-title">Set up a box over SSH</span>
										<span className="conn-sub">Install the engine on a fresh box</span>
									</span>
								</button>
							))}
						{onInstall && (
							<button
								type="button"
								className="conn-row"
								onClick={() => {
									setCreating(true);
									close();
								}}
							>
								<span className="conn-ico">
									<Cloud size={15} strokeWidth={1.75} />
								</span>
								<span className="conn-txt">
									<span className="conn-title">Create a new box</span>
									<span className="conn-sub">Spin up a VPS on Hetzner</span>
								</span>
							</button>
						)}
					</div>,
					document.body,
				)}
			{creating &&
				createPortal(
					<CreateBoxDialog
						onClose={() => setCreating(false)}
						onDone={(alias) => {
							setCreating(false);
							onChange(alias);
							close();
						}}
					/>,
					document.body,
				)}
		</>
	);
}
