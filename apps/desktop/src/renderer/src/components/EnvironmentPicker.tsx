import {
	type BoxWake,
	type ConnectStep,
	filled,
	inputsAt,
	PROTOCOL_VERSION,
	providerById,
	WAKE_PROVIDERS,
} from "@ateam/protocol";
import {
	ArrowUpCircle,
	ChevronLeft,
	Cloud,
	Laptop,
	Moon,
	Network,
	Plus,
	Server,
	X,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import type { HostStatus, WakeStatus } from "../../../shared/host";
import { BoxReadinessChecklist } from "./BoxReadinessChecklist";
import { ConnectSteps } from "./ConnectSteps";
import { CreateBoxDialog } from "./CreateBoxDialog";
import { PickerHeading, PickerRow, pickerTrigger } from "./picker";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

// The task's "Run on" control — the pill + popover style the global connection
// switcher used, moved into the New Task dialog. `null` alias = this Mac; a box alias
// runs the task on that VPS (cloning the project there on first use). Disabled
// options (no git remote to clone from) show why they can't be picked.
//
// Ways to add a box (create one on Hetzner, set one up over SSH, or connect a Tailscale
// endpoint) live behind one "Add a remote connection" row so the list stays short. Each
// step of adding one REPLACES the list rather than stacking under it, with a back arrow
// in the header: someone adding a box is looking at that, not at the other boxes. SSH boxes otherwise arrive on their own (whatever is
// in ~/.ssh/config); a Tailscale box has no such registry, so it's typed in once here.
//
// A Tailscale box a provider puts to sleep (boxd, Sprites) names that provider, its
// machine there, and the provider's key, the same fields Ateam Go asks for: the
// tailnet never wakes a sleeping box, the provider's API does. The key is checked
// with the provider and kept encrypted in the main process; this form never reads
// one back. Adding a listed box again, or its moon button, changes its provider.

export type EnvOption = {
	alias: string | null;
	label: string;
	disabled: boolean;
	transport?: "ssh" | "ws";
	/** In ~/.ssh/config but never connected — so almost certainly has no engine yet. */
	needsSetup?: boolean;
	/** A box left asleep at launch; picking it (or a task there) wakes it. */
	asleep?: boolean;
	/** A Tailscale box a provider puts to sleep: which one wakes it, and its machine. */
	wake?: BoxWake | null;
	/** Why the app's own last connect attempt failed. Outranks the other sub-labels:
	 *  a box that couldn't be reached or couldn't be upgraded is the reason it looks
	 *  idle, and it's the only one of these the user can act on. */
	error?: string;
	/** The protocol this box speaks, when it isn't the one this app speaks. Held and
	 *  usable, but some features will misbehave, so the row says so rather than
	 *  letting the weirdness turn up later with no explanation. */
	skew?: number;
	/** Whether this app can actually bring this box up to its version. False for a
	 *  dev build (it can only install releases, which may still be behind) and for a
	 *  ws box (no SSH to run the installer over). Gates the update button, so we
	 *  never offer an action that would run for a minute and change nothing. */
	updatable?: boolean;
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
	/** Connect a Tailscale endpoint (`host:port`), waking it through `wake` first and
	 *  saving that provider with it (null: none); rejects with a message to show. */
	onAdd?: (endpoint: string, wake: BoxWake | null) => Promise<void>;
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
	// Where the back arrow returns to: the list for a form opened from a box's row (its
	// moon or update button), the methods for one picked from the menu.
	const [backTo, setBackTo] = useState<"" | "menu">("");
	const [endpoint, setEndpoint] = useState("");
	// The Tailscale form's provider ("" for none), the box's inputs, and the
	// provider's key, asked for only while none is saved (or it is being replaced).
	const [providerId, setProviderId] = useState("");
	const [boxValues, setBoxValues] = useState<Record<string, string>>({});
	const [accountValues, setAccountValues] = useState<Record<string, string>>({});
	const [replaceKey, setReplaceKey] = useState(false);
	const [wakeSaved, setWakeSaved] = useState<WakeStatus>({});
	// The steps of waking and reaching the box this form is connecting.
	const [steps, setSteps] = useState<ConnectStep[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [dest, setDest] = useState("");
	const [installing, setInstalling] = useState(false);
	const [log, setLog] = useState("");
	const [installError, setInstallError] = useState<string | null>(null);
	// The box a Set-up-over-SSH just produced — probed by the readiness checklist.
	const [installedAlias, setInstalledAlias] = useState<string | null>(null);
	const [installedAgents, setInstalledAgents] = useState<string[]>([]);
	const [creating, setCreating] = useState(false);
	const logRef = useRef<HTMLPreElement>(null);

	const isRemote = value !== null;
	const label = environments.find((e) => e.alias === value)?.label ?? "Local";

	const close = () => {
		setOpen(false);
		setAddMode("");
	};

	const pick = (env: EnvOption) => {
		if (env.disabled) return;
		// Every ~/.ssh/config alias is offered here, including boxes that have never
		// run the engine — picking one of those used to just fail to connect. Send it
		// to the set-up form with the destination filled in instead. Worst case the
		// box IS already set up (installed by hand, never connected from this Mac):
		// install.sh is idempotent and ends by connecting, so that path still works.
		if (env.needsSetup && env.alias && env.transport !== "ws" && onInstall) {
			setDest(env.alias);
			setBackTo("");
			setAddMode("ssh");
			setInstallError(null);
			return;
		}
		onChange(env.alias);
		close();
	};

	const provider = providerById(providerId);
	const keySaved = provider ? wakeSaved[provider.id] === true : false;

	// What a provider needs from this Mac, and the steps of the connect underway.
	useEffect(() => {
		if (addMode !== "tailscale") return;
		void window.ateamHost.wakeStatus().then(setWakeSaved);
		return window.ateamHost.onConnectProgress((e) => {
			if (e.alias === endpoint.trim()) setSteps(e.steps);
		});
	}, [addMode, endpoint]);

	const back = () => {
		setAddMode(addMode === "menu" || addMode === "ready" ? "" : backTo);
		setError(null);
		setInstallError(null);
	};
	const stepTitle =
		addMode === "menu"
			? "Add a remote connection"
			: addMode === "tailscale"
				? "Tailscale box"
				: addMode === "ssh"
					? "Set up over SSH"
					: "Box set up";

	/** Open the Tailscale form, empty or for a listed box whose provider to change. */
	const openTailscale = (env?: EnvOption) => {
		setBackTo(env ? "" : "menu");
		setEndpoint(env?.alias ?? "");
		setProviderId(env?.wake?.id ?? "");
		setBoxValues(env?.wake?.box ?? {});
		setAccountValues({});
		setReplaceKey(false);
		setSteps([]);
		setError(null);
		setAddMode("tailscale");
	};

	// Enter connects from any of the Tailscale form's fields. (Escape backs out of any
	// step, through the popover's onEscapeKeyDown.)
	const formKeys = (e: KeyboardEvent) => {
		if (e.key === "Enter") void submit();
	};

	const submit = async () => {
		const ep = endpoint.trim();
		if (!ep || !onAdd || busy) return;
		setError(null);
		let wake: BoxWake | null = null;
		if (provider) {
			const boxInputs = inputsAt(provider, "box");
			if (!filled(provider, "box", boxValues)) {
				setError(`Enter the ${boxInputs.map((i) => i.label.toLowerCase()).join(" and ")}.`);
				return;
			}
			wake = {
				id: provider.id,
				box: Object.fromEntries(boxInputs.map((i) => [i.key, (boxValues[i.key] ?? "").trim()])),
			};
		}
		setBusy(true);
		setSteps([]);
		try {
			if (provider && (!keySaved || replaceKey)) {
				const accountInputs = inputsAt(provider, "account");
				if (!filled(provider, "account", accountValues)) {
					throw new Error(
						`Enter your ${provider.label} ${accountInputs.map((i) => i.label).join(" and ")}.`,
					);
				}
				// Checked with the provider before it is saved: a key that doesn't work is
				// said here, not as a box that never wakes.
				setWakeSaved(
					await window.ateamHost.saveWakeAccount(
						provider.id,
						Object.fromEntries(
							accountInputs.map((i) => [i.key, (accountValues[i.key] ?? "").trim()]),
						),
					),
				);
				setAccountValues({});
				setReplaceKey(false);
			}
			await onAdd(ep, wake);
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
			<Popover
				open={open}
				onOpenChange={(next) => {
					if (next) setOpen(true);
					else close();
				}}
			>
				<PopoverTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className={pickerTrigger}
						title="Run on — which machine runs this task"
					>
						{isRemote ? (
							<Server className="size-3.5" strokeWidth={1.75} />
						) : (
							<Laptop className="size-3.5" strokeWidth={1.75} />
						)}
						<span>{label}</span>
						<span
							className={cn(
								"size-1.5 flex-none rounded-full bg-muted-foreground",
								isRemote && "bg-success shadow-[0_0_6px_rgba(74,222,128,0.7)]",
							)}
						/>
					</Button>
				</PopoverTrigger>
				{/* Opens upward from the composer and grows up as the list grows, so its
				    edge stays next to the toggle however many environments there are. */}
				<PopoverContent
					side="top"
					align="start"
					collisionPadding={8}
					className="max-h-[min(70vh,420px)] w-[260px] overflow-y-auto p-1.5"
					// Escape backs out one add step at a time, and closes from the list.
					onEscapeKeyDown={(e) => {
						if (addMode === "") return;
						e.preventDefault();
						if (!busy && !installing) back();
					}}
				>
					<PickerHeading>
						{addMode === "" ? (
							<span>Run on</span>
						) : (
							<Button
								variant="ghost"
								className="h-auto gap-1 p-0 text-[11px] tracking-[0.4px] uppercase hover:bg-transparent"
								onClick={back}
								disabled={busy || installing}
								aria-label={`Back from ${stepTitle}`}
							>
								<ChevronLeft className="size-[13px]" strokeWidth={2} />
								<span>{stepTitle}</span>
							</Button>
						)}
					</PickerHeading>
					{addMode === "" &&
						environments.map((env) => {
							const active = env.alias === value;
							const skewTitle =
								env.skew === undefined
									? undefined
									: env.skew > PROTOCOL_VERSION
										? `This box runs a newer Ateam (protocol v${env.skew}; this app speaks v${PROTOCOL_VERSION}). Update Ateam on this Mac to catch up with it.`
										: `This box runs an older Ateam (protocol v${env.skew}; this app speaks v${PROTOCOL_VERSION}). It still works, but anything added since v${env.skew} will misbehave here. ${
												env.updatable
													? "Use the update button on this row to bring it up to this app's version."
													: env.transport === "ws"
														? "It's reachable only over its Tailscale endpoint, so this app can't run the installer on it. Update it over SSH."
														: "This dev build can't update it: the installer serves releases, and this protocol isn't in one yet. Use packages/server/scripts/install-remote.sh."
											}`;
							return (
								// A picker row + its side buttons (can't nest buttons). The wrap owns
								// the hover/active background so the highlight spans both.
								<div
									key={env.alias ?? "local"}
									className={cn(
										"group flex items-center rounded-md hover:bg-accent",
										active && "bg-accent",
									)}
								>
									<PickerRow
										className="flex-1 bg-transparent hover:bg-transparent"
										disabled={env.disabled}
										onClick={() => pick(env)}
										selected={active}
										icon={env.alias === null ? <Laptop /> : <Server />}
										title={env.label}
										tone={env.error ? "error" : env.skew !== undefined ? "warn" : undefined}
										subTitle={env.error ?? skewTitle}
										sub={
											env.error ??
											(env.skew !== undefined
												? // Framed as an UPDATE, the same thing the desktop does to itself,
													// rather than as an installer to re-run: that is the user's mental
													// model and it is the one the button next to it acts on. Short
													// enough to survive the 260px row, with the detail in the title.
													env.skew < PROTOCOL_VERSION
													? `update available (v${env.skew})`
													: `update this app (box is v${env.skew})`
												: env.disabled && env.alias !== null
													? "repo needs a git remote to run here"
													: env.asleep
														? "asleep, wakes when you use it"
														: env.needsSetup
															? "not set up — click to install the engine"
															: env.transport === "ws"
																? env.wake
																	? `${env.alias} · ${providerById(env.wake.id)?.label ?? env.wake.id}`
																	: "Tailscale"
																: undefined)
										}
									/>
									{/* A row that only STATES the box is behind leaves the user nowhere to
									    go: the fix lives in a terminal, which is exactly the gesture this
									    whole path exists to remove. The install form below already knows how
									    to run the installer over SSH and stream its log, so an update is that
									    same flow with the destination filled in. Kept off the row itself so a
									    skewed box stays selectable, which is the point of holding it. Not
									    hover-only like the buttons after it: this is the answer to "how do I
									    update it", so it stays visible. Amber ties it to the label. */}
									{env.skew !== undefined &&
										env.skew < PROTOCOL_VERSION &&
										env.alias &&
										env.updatable &&
										onInstall && (
											<Button
												variant="ghost"
												size="icon-xs"
												className="size-5 rounded-[5px] text-warning hover:bg-warning/15 hover:text-warning"
												title={`Update ${env.label} to this app's version over SSH`}
												aria-label={`Update ${env.label}`}
												onClick={() => {
													setDest(env.alias as string);
													setBackTo("");
													setAddMode("ssh");
													setInstallError(null);
												}}
											>
												<ArrowUpCircle className="size-[13px]" strokeWidth={2} />
											</Button>
										)}
									{env.transport === "ws" && onAdd && (
										<Button
											variant="ghost"
											size="icon-xs"
											className={rowSideButton}
											title={`Which provider wakes ${env.label}`}
											aria-label={`Which provider wakes ${env.label}`}
											onClick={() => openTailscale(env)}
										>
											<Moon className="size-[13px]" strokeWidth={2} />
										</Button>
									)}
									{env.alias !== null && onForget && (
										<Button
											variant="ghost"
											size="icon-xs"
											className={rowSideButton}
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
											<X className="size-[13px]" strokeWidth={2} />
										</Button>
									)}
								</div>
							);
						})}
					{(onAdd || onInstall) &&
						(addMode === "" ? (
							<PickerRow
								icon={<Plus />}
								title="Add a remote connection"
								onClick={() => setAddMode("menu")}
							/>
						) : addMode === "menu" ? (
							<>
								{onInstall && (
									<PickerRow
										icon={<Cloud />}
										title="Create a new box"
										sub="Spin up a VPS on Hetzner"
										onClick={() => {
											setCreating(true);
											close();
										}}
									/>
								)}
								{onInstall && (
									<PickerRow
										icon={<Server />}
										title="Set up a box over SSH"
										sub="Install the engine on a box you have"
										onClick={() => {
											setBackTo("menu");
											setAddMode("ssh");
											setInstallError(null);
										}}
									/>
								)}
								{onAdd && (
									<PickerRow
										icon={<Network />}
										title="Add a Tailscale box"
										sub="Connect one already on your tailnet"
										onClick={() => openTailscale()}
									/>
								)}
							</>
						) : addMode === "tailscale" ? (
							<div className={addForm}>
								<Input
									autoFocus
									className={formInput}
									placeholder="100.x.y.z:8787"
									aria-label="Tailscale address and port"
									value={endpoint}
									disabled={busy}
									onKeyDown={formKeys}
									onChange={(e) => setEndpoint(e.target.value)}
								/>
								<NativeSelect
									wrapperClassName="w-full"
									className={cn(formInput, "pr-8")}
									aria-label="Provider that puts this box to sleep"
									value={providerId}
									disabled={busy}
									onKeyDown={formKeys}
									onChange={(e) => {
										setProviderId(e.target.value);
										setError(null);
									}}
								>
									<NativeSelectOption value="">Always on (no provider)</NativeSelectOption>
									{WAKE_PROVIDERS.map((p) => (
										<NativeSelectOption key={p.id} value={p.id} title={p.wake?.hint}>
											{p.label}
										</NativeSelectOption>
									))}
								</NativeSelect>
								{provider &&
									inputsAt(provider, "box").map((i) => (
										<Input
											key={i.key}
											className={formInput}
											placeholder={`${i.label}: ${i.placeholder}`}
											aria-label={`${provider.label} ${i.label}`}
											value={boxValues[i.key] ?? ""}
											disabled={busy}
											onKeyDown={formKeys}
											onChange={(e) => setBoxValues((v) => ({ ...v, [i.key]: e.target.value }))}
										/>
									))}
								{provider && keySaved && !replaceKey ? (
									<span className={formNote}>
										{provider.label} key saved on this Mac.{" "}
										<Button
											variant="link"
											className="h-auto p-0 text-xs text-foreground underline"
											onClick={() => setReplaceKey(true)}
										>
											Replace
										</Button>
									</span>
								) : (
									provider &&
									inputsAt(provider, "account").map((i) => (
										<Input
											key={i.key}
											className={formInput}
											type={i.secret ? "password" : "text"}
											autoComplete="off"
											placeholder={`${i.label}: ${i.placeholder}`}
											aria-label={`${provider.label} ${i.label}`}
											value={accountValues[i.key] ?? ""}
											disabled={busy}
											onKeyDown={formKeys}
											onChange={(e) => setAccountValues((v) => ({ ...v, [i.key]: e.target.value }))}
										/>
									))
								)}
								{/* Sentences here (a provider's note, a whole error) wrap instead of
								    truncating: they are read, not scanned. */}
								{provider && !busy && !error ? (
									<span className={formNote}>{provider.wake?.note}</span>
								) : null}
								{busy && steps.length > 0 ? <ConnectSteps steps={steps} /> : null}
								<span className={cn(formNote, error && "text-destructive")}>
									{error ??
										(busy && steps.length === 0 ? "Connecting…" : busy ? "" : "Enter to connect")}
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
							<div className={addForm}>
								<Input
									autoFocus
									className={formInput}
									placeholder="ssh alias or user@host"
									aria-label="SSH destination to set up"
									value={dest}
									disabled={installing}
									onChange={(e) => setDest(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") void submitInstall();
									}}
								/>
								{log && (
									<pre
										ref={logRef}
										className="m-0 max-h-40 overflow-auto rounded-md bg-background p-2 font-mono text-[10px] whitespace-pre-wrap text-muted-foreground"
									>
										{log}
									</pre>
								)}
								<span className={cn(formNote, installError && "text-destructive")}>
									{installing
										? "Setting up the box…"
										: (installError ?? "Installs the engine over SSH, then connects")}
								</span>
								{!installing && (
									<Button
										variant="secondary"
										size="sm"
										className="self-start border text-foreground"
										onClick={() => void submitInstall()}
									>
										Set up
									</Button>
								)}
							</div>
						))}
				</PopoverContent>
			</Popover>
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

/** A row's hover-revealed side button (its provider, removing it). */
const rowSideButton =
	"mr-1.5 size-5 rounded-[5px] opacity-0 group-hover:opacity-100 hover:bg-white/8 hover:text-foreground focus-visible:opacity-100";
/** An add step's form, and its fields and sentences. */
const addForm = "flex flex-col gap-[3px] px-2.5 pt-1.5 pb-2";
const formInput = "h-auto bg-secondary px-2 py-1.5";
const formNote = "text-xs leading-[1.4] whitespace-normal text-muted-foreground";
