import {
	boxSupports,
	type ProxyCheck,
	type ProxyStatus,
	parseProxyUrl,
	proxyAddress,
} from "@ateam/protocol";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

// A box's own proxy (protocol proxy.ts): one address, and two switches for what
// goes out through it. The address carries the proxy's password, so it is typed
// here, sent to the box once, and dropped from state; the box only ever answers
// where the proxy is.

const errorText = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).replace(
		/^Error invoking remote method '[^']+': (Error: )?/,
		"",
	);

type Confirm = (title: string, body: string) => Promise<boolean>;

export function BoxProxy({
	alias,
	label,
	version,
	connected,
	confirm,
}: {
	alias: string;
	/** How the box is named in sentences. */
	label: string;
	version: number | null;
	connected: boolean;
	confirm: Confirm;
}) {
	return (
		<div className="box-card-section">
			<div className="box-card-label">
				Proxy <span className="gh-access-muted">· Optional</span>
			</div>
			{!connected ? (
				<p className="gh-access-muted">Connect to set a proxy for this box.</p>
			) : !boxSupports("proxy", version ?? 0) ? (
				<p className="gh-access-muted">Update this box to set a proxy for it.</p>
			) : (
				<ConnectedProxy key={alias} alias={alias} label={label} confirm={confirm} />
			)}
		</div>
	);
}

/** What the typed address will be saved as, or why it can't be. */
function preview(text: string): { ok: true; line: string } | { ok: false; line: string } | null {
	if (!text.trim()) return null;
	try {
		const up = parseProxyUrl(text);
		const auth = up.username !== undefined || up.password !== undefined;
		return {
			ok: true,
			line: `${proxyAddress(up)}, ${auth ? "with a username and password" : "with no username or password"}`,
		};
	} catch (e) {
		return { ok: false, line: errorText(e) };
	}
}

function checkLine(check: ProxyCheck): string {
	return check.ok
		? `Sites see ${check.ip}${check.country ? ` (${check.country})` : ""}.`
		: check.error;
}

function ConnectedProxy({
	alias,
	label,
	confirm,
}: {
	alias: string;
	label: string;
	confirm: Confirm;
}) {
	const [status, setStatus] = useState<ProxyStatus | null>(null);
	const [formOpen, setFormOpen] = useState(false);
	const [url, setUrl] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [check, setCheck] = useState<ProxyCheck | null>(null);
	const [refresh, setRefresh] = useState(0);
	const fieldId = useId();

	// biome-ignore lint/correctness/useExhaustiveDependencies: Refresh explicitly retries the status request.
	useEffect(() => {
		let live = true;
		void window.ateamHost
			.proxyStatus(alias)
			.then((s) => {
				if (!live) return;
				setStatus(s);
				setError("");
			})
			.catch((e) => {
				if (live) setError(errorText(e));
			});
		return () => {
			live = false;
		};
	}, [alias, refresh]);

	const runCheck = useCallback(async () => {
		setBusy("Checking…");
		try {
			setCheck(await window.ateamHost.checkProxy(alias));
		} catch (e) {
			setCheck({ ok: false, error: errorText(e) });
		} finally {
			setBusy(null);
		}
	}, [alias]);

	const save = async (patch: Parameters<typeof window.ateamHost.updateProxy>[1], label: string) => {
		setBusy(label);
		setError("");
		try {
			setStatus(await window.ateamHost.updateProxy(alias, patch));
			return true;
		} catch (e) {
			setError(errorText(e));
			return false;
		} finally {
			setBusy(null);
		}
	};

	const saveAddress = async () => {
		const typed = preview(url);
		if (!typed?.ok) {
			setError(typed?.line ?? "");
			return;
		}
		if (!(await save({ url }, "Saving…"))) return;
		// The password is on the box now: nothing here keeps it.
		setUrl("");
		setFormOpen(false);
		setCheck(null);
		await runCheck();
	};

	const remove = async () => {
		const on = status?.browser || status?.server;
		const ok = await confirm(
			`Remove the proxy from ${label}?`,
			on
				? "Its browser and agents go out from the box's own address again, at once."
				: "Ateam forgets its address and password on the box.",
		);
		if (!ok) return;
		if (await save({ url: null }, "Removing…")) setCheck(null);
	};

	if (!status) {
		return error ? (
			<div role="alert" className="gh-access-problem">
				{error}{" "}
				<Button size="xs" variant="ghost" onClick={() => setRefresh((n) => n + 1)}>
					Try again
				</Button>
			</div>
		) : (
			<p className="gh-access-muted">Loading…</p>
		);
	}

	const typed = preview(url);
	const showForm = formOpen || !status.address;
	const anyOn = status.browser || status.server;
	return (
		<div className="box-proxy">
			{status.address && !formOpen ? (
				<div className="box-lead-row">
					<span className="box-proxy-address">
						<code>{status.address}</code>
						<span className="gh-access-muted">
							{status.auth ? " · with a username and password" : " · no username or password"}
						</span>
					</span>
					<span className="box-proxy-actions">
						{busy ? <span className="gh-access-muted">{busy}</span> : null}
						<Button size="xs" variant="outline" disabled={!!busy} onClick={() => void runCheck()}>
							Check
						</Button>
						<Button size="xs" variant="ghost" disabled={!!busy} onClick={() => setFormOpen(true)}>
							Change
						</Button>
						<Button size="xs" variant="ghost" disabled={!!busy} onClick={() => void remove()}>
							Remove
						</Button>
					</span>
				</div>
			) : null}

			{showForm ? (
				<form
					className="box-proxy-form"
					onSubmit={(e) => {
						e.preventDefault();
						void saveAddress();
					}}
				>
					{!status.address ? (
						<p className="gh-access-muted">
							Send {label}'s traffic out through a proxy of yours: a residential or country-specific
							address for its browser, or your company's proxy for everything.
						</p>
					) : null}
					<label className="gh-access-muted" htmlFor={fieldId}>
						Proxy address
					</label>
					<div className="box-lead-row">
						<Input
							id={fieldId}
							type="password"
							className="h-7 text-[13px]"
							placeholder="http://user:password@host:port"
							autoComplete="off"
							spellCheck={false}
							value={url}
							disabled={!!busy}
							onChange={(e) => {
								setUrl(e.target.value);
								setError("");
							}}
						/>
						<Button size="sm" type="submit" disabled={!!busy || !typed?.ok}>
							{busy === "Saving…" ? busy : "Save"}
						</Button>
						{formOpen ? (
							<Button
								size="sm"
								variant="ghost"
								type="button"
								disabled={!!busy}
								onClick={() => {
									setFormOpen(false);
									setUrl("");
									setError("");
								}}
							>
								Cancel
							</Button>
						) : null}
					</div>
					{typed ? (
						<p className={typed.ok ? "gh-access-muted" : "gh-access-problem"}>{typed.line}</p>
					) : null}
					<p className="gh-access-muted">
						Your proxy provider's dashboard lists its host, port, username and password; for a
						company proxy, ask your network admin. http://, https:// and socks5:// all work. The
						address goes to {label} only, where agents running there can read it.
					</p>
				</form>
			) : null}

			{status.address ? (
				<div className="box-proxy-switches">
					<label className="check-row">
						<input
							type="checkbox"
							checked={status.browser}
							disabled={!!busy}
							onChange={(e) =>
								void save(
									{ browser: e.target.checked },
									e.target.checked ? "Turning on…" : "Turning off…",
								)
							}
						/>
						<span className="check-body">
							<span>Browser</span>
							<span className="gh-access-muted">
								The box's Chrome: what agents browse and your Browser panel shows. Applies within
								seconds, and open tabs stay open.
							</span>
						</span>
					</label>
					<label className="check-row">
						<input
							type="checkbox"
							checked={status.server}
							disabled={!!busy}
							onChange={(e) =>
								void save(
									{ server: e.target.checked },
									e.target.checked ? "Turning on…" : "Turning off…",
								)
							}
						/>
						<span className="check-body">
							<span>Server</span>
							<span className="gh-access-muted">
								Everything else: agents' terminals, git, gh, npm, curl and the engine. Agents
								started from now on use it; turning it off applies to running ones too. SSH
								connections (git@…) always go direct.
							</span>
						</span>
					</label>
				</div>
			) : null}

			{check ? (
				<p className={check.ok ? "gh-access-muted" : "gh-access-problem"}>{checkLine(check)}</p>
			) : null}
			{anyOn && !status.forwarder ? (
				<p className="gh-access-problem">
					The box's proxy forwarder isn't answering, so traffic set to use the proxy fails. Turn a
					switch off and on again to restart it; its log is ~/.ateam/proxy.log on the box.
				</p>
			) : null}
			{status.server && !status.engineFollows ? (
				<p className="gh-access-muted">
					Task titles and summaries this box writes still go out directly: its Node is older than
					24.14, which can't switch those at runtime.
				</p>
			) : null}
			{anyOn ? (
				<p className="gh-access-muted">
					If the proxy stops answering, that traffic fails rather than leaving from the box's own
					address.
				</p>
			) : null}
			{error && status ? (
				<div role="alert" className="gh-access-problem">
					{error}
				</div>
			) : null}
		</div>
	);
}
