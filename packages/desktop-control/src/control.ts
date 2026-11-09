import { randomBytes } from "node:crypto";

export type Owner = { kind: "agent" | "human"; label: string; expiresAt: number | null };
type Lease = Owner & { token: string };

/** One display, one owner. Capabilities never appear in public status. */
export class DesktopControl {
	private lease: Lease | null = null;
	private tail: Promise<unknown> = Promise.resolve();
	private running: AbortController | null = null;
	private ready = true;
	private timer: ReturnType<typeof setTimeout> | undefined;
	// Called before switching owners: release keys/buttons held by a VNC viewer.
	onRevoke = () => {};
	// A click is a takeover, so a person who clicked and then only watches must
	// not lock the agent out until they leave the viewer. Their next gesture
	// takes control back.
	constructor(
		private readonly ttlMs = 90_000,
		private readonly humanIdleMs = 60_000,
	) {}

	status(): Owner | null {
		this.expire();
		if (!this.lease) return null;
		const { kind, label, expiresAt } = this.lease;
		return { kind, label, expiresAt };
	}

	acquire(label: string): { lease: string; owner: Owner } {
		this.expire();
		if (this.lease)
			throw new Error(`Desktop is controlled by ${this.lease.label}. Wait for release.`);
		const token = randomBytes(24).toString("hex");
		this.lease = { kind: "agent", label, token, expiresAt: Date.now() + this.ttlMs };
		this.armExpiry();
		return { lease: token, owner: this.status() as Owner };
	}

	renew(token: string): Owner {
		const lease = this.requireAgent(token);
		lease.expiresAt = Date.now() + this.ttlMs;
		this.armExpiry();
		return this.status() as Owner;
	}

	releaseAgent(token: string): void {
		this.requireAgent(token);
		this.revoke();
	}

	/** Revoke immediately; don't enable viewer input until the interrupted action
	 * has exited and cleaned up its keys. Queued agent actions recheck ownership. */
	async takeOver(viewer: string): Promise<void> {
		// Direct-input viewers confirm ownership at the start of each gesture.
		// Re-confirmation must not release modifiers/buttons held by that viewer.
		if (this.canInput(viewer)) return;
		this.revoke();
		this.ready = false;
		this.lease = {
			kind: "human",
			label: "a desktop viewer",
			token: viewer,
			expiresAt: Date.now() + this.humanIdleMs,
		};
		this.armExpiry();
		await this.enqueue(async () => {});
		if (this.lease?.token === viewer) this.ready = true;
	}

	/** Input from the controlling viewer keeps its control alive. Called per
	 * forwarded RFB message, so it only moves the deadline; the timer re-arms
	 * itself when it fires early. */
	viewerInput(viewer: string): void {
		if (this.lease?.kind === "human" && this.lease.token === viewer)
			this.lease.expiresAt = Date.now() + this.humanIdleMs;
	}

	releaseViewer(viewer: string): void {
		if (this.lease?.kind === "human" && this.lease.token === viewer) this.revoke();
	}

	canInput(viewer: string): boolean {
		return this.ready && this.lease?.kind === "human" && this.lease.token === viewer;
	}

	async act<T>(token: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
		this.requireAgent(token);
		return this.enqueue(async () => {
			this.renew(token);
			const abort = new AbortController();
			this.running = abort;
			try {
				const result = await action(abort.signal);
				// An action that finished just as takeover arrived is still interrupted.
				abort.signal.throwIfAborted();
				this.renew(token);
				return result;
			} finally {
				this.running = null;
				// A failed action skips renew(); its overdue lease now expires.
				this.armExpiry();
			}
		});
	}

	close(): void {
		this.revoke();
	}

	private enqueue<T>(action: () => Promise<T>): Promise<T> {
		const result = this.tail.then(action);
		this.tail = result.catch(() => {});
		return result;
	}
	private requireAgent(token: string): Lease {
		this.expire();
		if (!token || this.lease?.kind !== "agent" || this.lease.token !== token)
			throw new Error(
				"No valid desktop lease. Acquire control again; a person may have taken over.",
			);
		return this.lease;
	}
	private expire(): void {
		// An agent action in progress is activity, not an abandoned lease: long
		// typing must not revoke its own lease. act() renews when it finishes.
		if (this.running && this.lease?.kind === "agent") return;
		if (this.lease?.expiresAt != null && this.lease.expiresAt <= Date.now()) this.revoke();
	}
	private armExpiry(): void {
		clearTimeout(this.timer);
		const expiresAt = this.lease?.expiresAt;
		if (expiresAt == null) return;
		this.timer = setTimeout(
			() => {
				this.expire();
				// Re-arm for a deadline viewerInput() moved. A lease held past its
				// deadline by a running action is rechecked when the action ends.
				const next = this.lease?.expiresAt;
				if (next != null && next > Date.now()) this.armExpiry();
			},
			Math.max(expiresAt - Date.now(), 0) + 1,
		);
		this.timer.unref();
	}
	private revoke(): void {
		clearTimeout(this.timer);
		this.lease = null;
		this.running?.abort(new Error("Desktop control was released, expired, or taken over."));
		this.onRevoke();
	}
}
