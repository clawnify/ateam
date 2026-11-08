import { boxSupports, type DotfilesConfig, type DotfilesStatus } from "@ateam/protocol";
import { useEffect, useId, useState } from "react";
import { stripAnsi } from "../lib/ansi";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const EMPTY: DotfilesConfig = { repository: "", script: "" };
const errorText = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).replace(
		/^Error invoking remote method '[^']+': (Error: )?/,
		"",
	);

function Fields({
	value,
	onChange,
	disabled,
}: {
	value: DotfilesConfig;
	onChange: (value: DotfilesConfig) => void;
	disabled: boolean;
}) {
	const id = useId();
	return (
		<>
			<label className="dotfiles-field" htmlFor={`${id}-repository`}>
				Repository URL
				<Input
					id={`${id}-repository`}
					value={value.repository}
					disabled={disabled}
					placeholder="https://github.com/you/dotfiles"
					onChange={(e) => onChange({ ...value, repository: e.target.value })}
				/>
			</label>
			<label className="dotfiles-field" htmlFor={`${id}-script`}>
				Install script (optional)
				<Input
					id={`${id}-script`}
					value={value.script}
					disabled={disabled}
					placeholder="Detect automatically, e.g. install.sh"
					onChange={(e) => onChange({ ...value, script: e.target.value })}
				/>
			</label>
		</>
	);
}

export function DotfilesDefault() {
	const [value, setValue] = useState(EMPTY);
	const [loaded, setLoaded] = useState(false);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	useEffect(() => {
		let live = true;
		void window.ateam.settings
			.get()
			.then((s) => {
				if (live) {
					setValue(s.settings.engine.dotfiles ?? EMPTY);
					setLoaded(true);
				}
			})
			.catch((e) => {
				if (live) setMessage(errorText(e));
			});
		return () => {
			live = false;
		};
	}, []);
	const save = async () => {
		setBusy(true);
		setMessage("");
		try {
			await window.ateam.settings.update({
				engine: { dotfiles: value.repository.trim() ? value : null },
			});
			setMessage(
				value.repository.trim()
					? "Default saved. Open a box to preview and apply it."
					: "Default cleared. Files already installed stay on each box.",
			);
		} catch (e) {
			setMessage(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="box-card dotfiles" aria-label="Default dotfiles">
			<div className="box-card-title">Default dotfiles</div>
			<p className="gh-access-muted">
				Optional. Your shell, tools and agent configuration from a Git repository. This default
				follows engine settings sync; saving it never runs an installer.
			</p>
			<Fields value={value} onChange={setValue} disabled={!loaded || busy} />
			<div>
				<Button size="xs" variant="outline" disabled={!loaded || busy} onClick={() => void save()}>
					{busy ? "Saving…" : value.repository.trim() ? "Save default" : "Clear default"}
				</Button>
			</div>
			{message ? <output className="gh-access-muted">{message}</output> : null}
		</section>
	);
}

export function BoxDotfiles({
	alias,
	label,
	version,
	connected,
}: {
	alias: string;
	label: string;
	version: number | null;
	connected: boolean;
}) {
	return (
		<div className="box-card-section">
			<div className="box-card-label">
				Dotfiles <span className="gh-access-muted">· Optional</span>
			</div>
			{!connected ? (
				<p className="gh-access-muted">Connect to preview and apply dotfiles.</p>
			) : !boxSupports("dotfiles", version ?? 0) ? (
				<p className="gh-access-muted">Update this box to preview and apply dotfiles.</p>
			) : (
				<ConnectedDotfiles key={alias} alias={alias} label={label} />
			)}
		</div>
	);
}

function ConnectedDotfiles({ alias, label }: { alias: string; label: string }) {
	const [status, setStatus] = useState<DotfilesStatus | null>(null);
	const [value, setValue] = useState(EMPTY);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [refresh, setRefresh] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Refresh explicitly retries the status request.
	useEffect(() => {
		let live = true;
		void window.ateamHost
			.dotfilesStatus(alias)
			.then((s) => {
				if (!live) return;
				setStatus(s);
				setValue(s.prepared?.config ?? s.run?.plan.config ?? s.defaultConfig ?? EMPTY);
				setError("");
			})
			.catch((e) => {
				if (live) setError(errorText(e));
			});
		return () => {
			live = false;
		};
	}, [alias, refresh]);
	useEffect(() => {
		if (status?.run?.state !== "running") return;
		let live = true;
		const timer = setInterval(() => {
			void window.ateamHost
				.dotfilesStatus(alias)
				.then((s) => {
					if (live) {
						setStatus(s);
						setError("");
					}
				})
				.catch((e) => {
					if (live) setError(errorText(e));
				});
		}, 1500);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [alias, status?.run?.state]);
	const act = async (kind: "preview" | "apply") => {
		setBusy(kind);
		setError("");
		try {
			if (kind === "preview") {
				setStatus((s) => (s ? { ...s, prepared: null } : s));
				const plan = await window.ateamHost.prepareDotfiles(alias, value);
				setValue(plan.config);
				setStatus((s) => ({
					defaultConfig: s?.defaultConfig ?? null,
					run: s?.run ?? null,
					prepared: plan,
				}));
			} else if (status?.prepared)
				setStatus(await window.ateamHost.applyDotfiles(alias, status.prepared.id));
		} catch (e) {
			if (kind === "apply") setStatus((s) => (s ? { ...s, prepared: null } : s));
			setError(errorText(e));
		} finally {
			setBusy(null);
		}
	};
	const disabled = !!busy || !status || status.run?.state === "running";
	const plan = status?.prepared;
	const reviewed =
		plan && plan.config.repository === value.repository && plan.config.script === value.script;
	return (
		<div className="dotfiles">
			<p className="gh-access-muted">
				Preview fetches the repository using {label}'s Git access. Apply runs its script on this box
				as your engine user, without interactive input.
			</p>
			<Fields value={value} onChange={setValue} disabled={disabled} />
			<div>
				<Button
					size="xs"
					variant="outline"
					disabled={disabled || !value.repository.trim()}
					onClick={() => void act("preview")}
				>
					{busy === "preview" ? "Preparing…" : "Preview"}
				</Button>
			</div>
			{reviewed ? (
				<div className="dotfiles-preview">
					<p>
						Revision <code>{plan.commit.slice(0, 12)}</code>
					</p>
					<p className="gh-access-muted">
						Checkout: <code>{plan.directory}</code>
					</p>
					{plan.script ? (
						<>
							<p>
								Runs <code>{plan.script}</code>. Only apply a repository you trust: its script can
								change files and install tools on {label}.
							</p>
							<Button size="xs" disabled={disabled} onClick={() => void act("apply")}>
								{busy === "apply" ? "Starting…" : `Apply to ${label}`}
							</Button>
						</>
					) : (
						<p>
							No install script found. Enter a relative executable script path, then preview again.
						</p>
					)}
				</div>
			) : null}
			{error ? (
				<div role="alert" className="gh-access-problem">
					{error}{" "}
					<Button
						size="xs"
						variant="ghost"
						disabled={!!busy}
						onClick={() => setRefresh((n) => n + 1)}
					>
						Refresh status
					</Button>
				</div>
			) : null}
			{status?.run ? (
				<div aria-live="polite" className="dotfiles-result">
					<p>
						Last apply: {status.run.state} · {status.run.plan.commit.slice(0, 12)}
						{status.run.exitCode !== null ? ` · exit ${status.run.exitCode}` : ""}
					</p>
					{status.run.state === "running" ? (
						<p className="gh-access-muted">
							You can close this page. The box stays awake until the installer finishes.
						</p>
					) : null}
					{status.run.message ? <p>{status.run.message}</p> : null}
					{status.run.log ? <pre className="dotfiles-log">{stripAnsi(status.run.log)}</pre> : null}
				</div>
			) : null}
		</div>
	);
}
