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
	constructor(private readonly ttlMs = 90_000) {}

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
		this.lease = { kind: "human", label: "a desktop viewer", token: viewer, expiresAt: null };
		await this.enqueue(async () => {});
		if (this.lease?.token === viewer) this.ready = true;
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
		if (this.lease?.expiresAt != null && this.lease.expiresAt <= Date.now()) this.revoke();
	}
	private armExpiry(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.expire(), this.ttlMs + 1);
		this.timer.unref();
	}
	private revoke(): void {
		clearTimeout(this.timer);
		this.lease = null;
		this.running?.abort(new Error("Desktop control was released, expired, or taken over."));
		this.onRevoke();
	}
}
