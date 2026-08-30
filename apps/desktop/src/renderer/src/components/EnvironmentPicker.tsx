import { Check, Cloud, Laptop, Network, Plus, Server, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { HostStatus } from "../../../shared/host";
import { BoxReadinessChecklist } from "./BoxReadinessChecklist";
import { CreateBoxDialog } from "./CreateBoxDialog";

// The task's "Run on" control — the pill + popover style the global connection
// switcher used, moved into the New Task dialog. `null` alias = this Mac; a box alias
// runs the task on that VPS (cloning the project there on first use). Disabled
// options (no git remote to clone from) show why they can't be picked.
//
// Ways to add a box (create one on Hetzner, set one up over SSH, or connect a Tailscale
// endpoint) live behind one "Add a remote connection" row so the list stays short — it
// expands to the methods on click. SSH boxes otherwise arrive on their own (whatever is
// in ~/.ssh/config); a Tailscale box has no such registry, so it's typed in once here.

const POP_W = 260;

export type EnvOption = {
	alias: string | null;
	label: string;
	disabled: boolean;
	transport?: "ssh" | "ws";
	/** In ~/.ssh/config but never connected — so almost certainly has no engine yet. */
	needsSetup?: boolean;
	/** Why the app's own last connect attempt failed. Outranks the other sub-labels:
	 *  a box that couldn't be reached or couldn't be upgraded is the reason it looks
	 *  idle, and it's the only one of these the user can act on. */
	error?: string;
};

export function EnvironmentPicker({
	environments,
	value,
	onChange,
	onAdd,
	onInstall,
	onForget,
}: {
	environments: EnvOption[];
	value: string | null;
	onChange: (alias: string | null) => void;
	/** Connect a Tailscale endpoint (`host:port`); rejects with a message to show. */
	onAdd?: (endpoint: string) => Promise<void>;
	/** Install the engine on a fresh SSH box (`alias` or `user@host`), streaming the
	 *  installer's output; resolves once the box is set up and connected. */
	onInstall?: (dest: string, onLog: (chunk: string) => void) => Promise<HostStatus>;
	/** Remove a box from this list (disconnecting it first if connected). */
	onForget?: (alias: string) => Promise<void>;
}) {
	// The add-a-connection section: "" collapsed → "menu" (the methods) → a chosen
	// method's inline form → "ready" (the readiness checklist after an SSH set-up).
	// "Create a new box" opens a modal instead (too big for here).
	const [addMode, setAddMode] = useState<"" | "menu" | "ssh" | "tailscale" | "ready">("");
	const [endpoint, setEndpoint] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);
	const [dest, setDest] = useState("");
	const [installing, setInstalling] = useState(false);
	const [log, setLog] = useState("");
	const [installError, setInstallError] = useState<string | null>(null);
	// The box a Set-up-over-SSH just produced — probed by the readiness checklist.
	const [installedAlias, setInstalledAlias] = useState<string | null>(null);
	const [installedAgents, setInstalledAgents] = useState<string[]>([]);
	const [creating, setCreating] = useState(false);
	const btnRef = useRef<HTMLButtonElement>(null);
	const popRef = useRef<HTMLDivElement>(null);
	const logRef = useRef<HTMLPreElement>(null);

	const isRemote = value !== null;
	const label = environments.find((e) => e.alias === value)?.label ?? "Local";

	const close = () => {
		setPos(null);
		setAddMode("");
	};
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
		// Every ~/.ssh/config alias is offered here, including boxes that have never
		// run the engine — picking one of those used to just fail to connect. Send it
		// to the set-up form with the destination filled in instead. Worst case the
		// box IS already set up (installed by hand, never connected from this Mac):
		// install.sh is idempotent and ends by connecting, so that path still works.
		if (env.needsSetup && env.alias && env.transport !== "ws" && onInstall) {
			setDest(env.alias);
			setAddMode("ssh");
			setInstallError(null);
			return;
		}
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
			const status = await onInstall(d, (chunk) => setLog((prev) => prev + chunk));
			// install() sets the box up AND connects it — select it right away (so clicking
			// away can't strand the pick), then show its readiness checklist.
			onChange(d);
			setDest("");
			setInstalledAlias(d);
			setInstalledAgents(status.info.agents);
			setAddMode("ready");
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
							<div
								key={env.label}
								className={`conn-row-wrap ${env.alias === value ? "active" : ""}`}
							>
								<button
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
										{env.error ? (
											<span className="conn-sub conn-sub-err" title={env.error}>
												{env.error}
											</span>
										) : env.disabled && env.alias !== null ? (
											<span className="conn-sub">repo needs a git remote to run here</span>
										) : env.needsSetup ? (
											<span className="conn-sub">not set up — click to install the engine</span>
										) : env.transport === "ws" ? (
											<span className="conn-sub">Tailscale</span>
										) : null}
									</span>
									{env.alias === value ? <Check size={15} strokeWidth={2.25} /> : null}
								</button>
								{env.alias !== null && onForget && (
									<button
										type="button"
										className="conn-forget"
										title={`Remove ${env.label} from this list`}
										aria-label={`Remove ${env.label} from this list`}
										onClick={() => {
											const alias = env.alias;
											if (!alias) return;
											// Removing the selected box falls back to Local; setting the
											// box up again is the way to bring it back.
											if (alias === value) onChange(null);
											void onForget(alias);
										}}
									>
										<X size={13} strokeWidth={2} />
									</button>
								)}
							</div>
						))}
						{(onAdd || onInstall) &&
							(addMode === "" ? (
								<button type="button" className="conn-row" onClick={() => setAddMode("menu")}>
									<span className="conn-ico">
										<Plus size={15} strokeWidth={1.75} />
									</span>
									<span className="conn-txt">
										<span className="conn-title">Add a remote connection</span>
									</span>
								</button>
							) : addMode === "menu" ? (
								<>
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
									{onInstall && (
										<button
											type="button"
											className="conn-row"
											onClick={() => {
												setAddMode("ssh");
												setInstallError(null);
											}}
										>
											<span className="conn-ico">
												<Server size={15} strokeWidth={1.75} />
											</span>
											<span className="conn-txt">
												<span className="conn-title">Set up a box over SSH</span>
												<span className="conn-sub">Install the engine on a box you have</span>
											</span>
										</button>
									)}
									{onAdd && (
										<button
											type="button"
											className="conn-row"
											onClick={() => {
												setAddMode("tailscale");
												setError(null);
											}}
										>
											<span className="conn-ico">
												<Network size={15} strokeWidth={1.75} />
											</span>
											<span className="conn-txt">
												<span className="conn-title">Add a Tailscale box</span>
												<span className="conn-sub">Connect one already on your tailnet</span>
											</span>
										</button>
									)}
								</>
							) : addMode === "tailscale" ? (
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
												setAddMode("menu");
												setError(null);
											}
										}}
									/>
									<span className="conn-sub">
										{busy ? "Connecting…" : (error ?? "The box's Tailscale address")}
									</span>
								</div>
							) : addMode === "ready" ? (
								installedAlias && (
									<BoxReadinessChecklist
										alias={installedAlias}
										agents={installedAgents}
										title="Box set up — finish these in the box’s terminal:"
										onDone={close}
									/>
								)
							) : (
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
												setAddMode("menu");
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
							))}
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
