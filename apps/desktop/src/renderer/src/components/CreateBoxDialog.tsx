import type { AgentDTO } from "@ateam/protocol";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ProviderOptions } from "../../../shared/host";
import { stripAnsi } from "../lib/ansi";
import { HetznerLogo } from "./HetznerLogo";

// "Create a box": Ateam stands up a fresh VPS at a provider, generates the SSH key,
// joins Tailscale, and installs the engine. Regions + sizes are fetched with the token,
// so they reflect the account's REAL availability instead of a hardcoded guess that can
// fail at create time. The two credentials say where they come from: neither console
// can be pre-filled from a link (Hetzner's token page sits under a project id), so each
// gets the exact path and a button to the console. Once the box is up, the dialog hands
// it on (`onDone`): what's left to set up is the box's own page.
export function CreateBoxDialog({
	onDone,
	onClose,
}: {
	/** The box is created + connected; `alias` is its ssh_config name. */
	onDone: (alias: string) => void;
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	const [token, setToken] = useState("");
	const [tsKey, setTsKey] = useState("");
	const [saved, setSaved] = useState({ hetznerToken: false, tailscaleAuthKey: false });
	const [options, setOptions] = useState<ProviderOptions | null>(null);
	const [region, setRegion] = useState("");
	const [size, setSize] = useState("");
	const [loadingOpts, setLoadingOpts] = useState(false);
	const [optsError, setOptsError] = useState<string | null>(null);
	const [started, setStarted] = useState(false);
	const [busy, setBusy] = useState(false);
	const [stages, setStages] = useState<string[]>([]);
	const [log, setLog] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [agents, setAgents] = useState<AgentDTO[]>([]);
	const [preinstall, setPreinstall] = useState<string[]>([]);
	const [browser, setBrowser] = useState(true);
	const browserSupported =
		options?.serverTypes.find((s) => s.slug === size)?.architecture !== "arm";
	const logRef = useRef<HTMLPreElement>(null);

	const loadOptions = async () => {
		setLoadingOpts(true);
		setOptsError(null);
		try {
			const o = await window.ateamHost.providerOptions(token.trim() || undefined);
			setOptions(o);
			setRegion((r) => r || o.locations[0]?.slug || "");
		} catch (e) {
			setOptsError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoadingOpts(false);
		}
	};

	useEffect(() => {
		void window.ateamHost.secretsStatus().then((s) => {
			setSaved(s);
			// A saved token means we can show real availability immediately.
			if (s.hetznerToken) void loadOptions();
		});
		void window.ateam.agents.list().then(setAgents);
		// biome-ignore lint/correctness/useExhaustiveDependencies: run once on open
	}, []);
	useEffect(() => {
		if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
	}, [log]);

	// Only sizes actually available in the chosen region (empty `locations` = unknown → offer it).
	const availableSizes = options
		? options.serverTypes.filter((st) => st.locations.length === 0 || st.locations.includes(region))
		: [];
	// Keep the chosen size valid as the region changes, starting from the smallest with
	// 4 GB: agents need about a gigabyte each, and the smallest Hetzner sells has one.
	useEffect(() => {
		if (availableSizes.length > 0 && !availableSizes.some((s) => s.slug === size)) {
			setSize((availableSizes.find((s) => s.memory >= 4) ?? availableSizes[0])?.slug ?? "");
		}
		// biome-ignore lint/correctness/useExhaustiveDependencies: react to region/options only
	}, [region, options]);

	const run = async () => {
		if (!name.trim()) {
			setError("Please name the box.");
			return;
		}
		if (!options || !region || !size) {
			setError("Load regions & sizes first.");
			return;
		}
		setError(null);
		setStages([]);
		setLog("");
		setStarted(true);
		setBusy(true);
		const offProgress = window.ateamHost.onCreateProgress((e) => setStages((s) => [...s, e.stage]));
		const offLog = window.ateamHost.onInstallLog((e) => setLog((l) => l + e.chunk));
		try {
			const status = await window.ateamHost.createBox({
				name: name.trim(),
				region,
				size,
				hetznerToken: token.trim() || undefined,
				tailscaleAuthKey: tsKey.trim() || undefined,
				agents: preinstall.length ? preinstall : undefined,
				browser: browser && browserSupported,
			});
			// Created + connected (always a remote engine): what's left to make it
			// task-ready (GitHub, phone, agent sign-in) is on its own page.
			if (status.alias) onDone(status.alias);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			offProgress();
			offLog();
			setBusy(false);
		}
	};

	return (
		// A click beside the dialog while it works would only hide the progress: the box
		// is still being made, and lands on its page when it's done.
		<div className="overlay" onMouseDown={() => !busy && onClose()}>
			<div className="dialog createbox" onMouseDown={(e) => e.stopPropagation()}>
				<div className="cb-head">
					<HetznerLogo size={17} />
					<span className="cb-title">Create a box</span>
					<span className="cb-sub">Hetzner Cloud</span>
					<button type="button" className="navbtn cb-x" onClick={onClose} aria-label="Close">
						<X size={15} strokeWidth={1.75} />
					</button>
				</div>

				{started ? (
					<div className="cb-progress">
						<ul className="cb-stages">
							{stages.map((s, i) => (
								<li
									key={`${i}-${s}`}
									className={i === stages.length - 1 && busy ? "active" : "done"}
								>
									{s}
								</li>
							))}
						</ul>
						{log && (
							<pre ref={logRef} className="cb-log">
								{stripAnsi(log)}
							</pre>
						)}
						{error && <div className="cb-error">{error}</div>}
						{!busy ? (
							<div className="cb-actions">
								<button
									type="button"
									className="cb-back"
									onClick={() => {
										setStarted(false);
										setError(null);
									}}
								>
									Back
								</button>
								<button type="button" className="cb-create" onClick={() => void run()}>
									Try again
								</button>
							</div>
						) : null}
					</div>
				) : (
					<div className="cb-form">
						<label className="cb-row">
							<span>Name</span>
							<input
								className="cb-input"
								value={name}
								placeholder="my-box"
								// biome-ignore lint/a11y/noAutofocus: first field of a just-opened dialog
								autoFocus
								onChange={(e) => setName(e.target.value)}
							/>
						</label>
						<label className="cb-row">
							<span>Hetzner API token</span>
							<input
								className="cb-input"
								type="password"
								value={token}
								placeholder={
									saved.hetznerToken ? "saved, leave blank to reuse it" : "paste your token"
								}
								// A new token means a possibly different account: reload availability.
								onChange={(e) => {
									setToken(e.target.value);
									setOptions(null);
								}}
							/>
						</label>
						{!saved.hetznerToken && (
							<div className="cb-help">
								<span>
									In the Hetzner Console, open a project, then <b>Security</b> → <b>API tokens</b> →{" "}
									<b>Generate API token</b>, with <b>Read &amp; Write</b>. Hetzner shows it once.
								</span>
								<button
									type="button"
									className="cb-link"
									onClick={() =>
										void window.ateamHost.openConsole("https://console.hetzner.com/projects")
									}
								>
									Open the Hetzner Console
								</button>
							</div>
						)}
						<label className="cb-row">
							<span>Tailscale auth key (optional)</span>
							<input
								className="cb-input"
								type="password"
								value={tsKey}
								placeholder={
									saved.tailscaleAuthKey ? "saved, leave blank to reuse it" : "tskey-auth-…"
								}
								onChange={(e) => setTsKey(e.target.value)}
							/>
						</label>
						{!saved.tailscaleAuthKey && (
							<div className="cb-help">
								<span>
									Leave it empty to approve the box on Tailscale's page when it's created. Or make
									one under <b>Settings</b> → <b>Keys</b> → <b>Generate auth key</b>: turn on{" "}
									<b>Tags</b> so the box stays on your tailnet for good, and <b>Reusable</b> if
									Ateam should use it for your next boxes too.
								</span>
								<button
									type="button"
									className="cb-link"
									onClick={() =>
										void window.ateamHost.openConsole(
											"https://console.tailscale.com/admin/settings/keys",
										)
									}
								>
									Open Tailscale's keys
								</button>
							</div>
						)}

						{options ? (
							<>
								<label className="cb-row">
									<span>Region</span>
									<select
										className="cb-input"
										value={region}
										onChange={(e) => setRegion(e.target.value)}
									>
										{options.locations.map((l) => (
											<option key={l.slug} value={l.slug}>
												{l.label}
											</option>
										))}
									</select>
								</label>
								<label className="cb-row">
									<span>Size</span>
									<select
										className="cb-input"
										value={size}
										onChange={(e) => setSize(e.target.value)}
									>
										{availableSizes.map((s) => (
											<option key={s.slug} value={s.slug}>
												{s.label}
											</option>
										))}
									</select>
								</label>
								<label className="cb-agent">
									<input
										type="checkbox"
										checked={browser && browserSupported}
										disabled={!browserSupported}
										onChange={(e) => setBrowser(e.target.checked)}
									/>
									{browserSupported
										? "Include browser for web tasks"
										: "Browser requires an x86 size"}
								</label>
								{agents.length > 0 && (
									<div className="cb-row">
										<span>Preinstall agents (optional)</span>
										<div className="cb-agents">
											{agents.map((a) => (
												<label key={a.id} className="cb-agent">
													<input
														type="checkbox"
														checked={preinstall.includes(a.id)}
														onChange={(e) =>
															setPreinstall((cur) =>
																e.target.checked ? [...cur, a.id] : cur.filter((id) => id !== a.id),
															)
														}
													/>
													{a.label}
												</label>
											))}
										</div>
										<span className="cb-sub">You sign in (OAuth) on the box afterward.</span>
									</div>
								)}
								{error && <div className="cb-error">{error}</div>}
								<button type="button" className="cb-create" onClick={() => void run()}>
									Create box
								</button>
							</>
						) : (
							<>
								{optsError && <div className="cb-error">{optsError}</div>}
								<button
									type="button"
									className="cb-create"
									disabled={loadingOpts || (!token.trim() && !saved.hetznerToken)}
									onClick={() => void loadOptions()}
								>
									{loadingOpts ? "Loading…" : "Load regions & sizes"}
								</button>
							</>
						)}
						<div className="cb-hint">Created on your Hetzner account.</div>
					</div>
				)}
			</div>
		</div>
	);
}
