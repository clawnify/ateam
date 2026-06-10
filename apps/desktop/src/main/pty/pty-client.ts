import { spawn as spawnProc } from "node:child_process";
import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SpawnOptions {
	terminalId: string;
	shell: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	cols?: number;
	rows?: number;
	agentId?: string;
}

/**
 * Talks to the standalone PTY daemon over a unix socket, exposing the same
 * surface the old in-process PtyManager did. Because the daemon is a detached
 * process, sessions survive an app restart: on connect we learn which terminals
 * are still alive and the renderer re-attaches (snapshot replay). Quitting the
 * app just disconnects — it never kills sessions.
 */
export class PtyClient extends EventEmitter {
	private sock: Socket | null = null;
	private live = new Set<string>();
	private buf = "";
	private reqId = 0;
	private pending = new Map<number, (v: Record<string, unknown>) => void>();
	private outbox: string[] = [];
	private connecting = false;

	constructor(
		private readonly daemonPath: string,
		private readonly sockPath: string,
		private readonly electronExec: string,
	) {
		super();
	}

	async connect(): Promise<void> {
		if (await this.tryConnect()) return;
		this.spawnDaemon();
		for (let i = 0; i < 50; i++) {
			await delay(80);
			if (await this.tryConnect()) return;
		}
		throw new Error("PTY daemon did not become reachable");
	}

	private tryConnect(): Promise<boolean> {
		return new Promise((resolve) => {
			const s = connect(this.sockPath);
			s.once("connect", () => {
				this.attach(s);
				resolve(true);
			});
			s.once("error", () => resolve(false));
		});
	}

	private attach(s: Socket): void {
		this.sock = s;
		s.on("data", (chunk) => {
			this.buf += chunk.toString("utf8");
			let nl: number;
			// biome-ignore lint/suspicious/noAssignInExpressions: stream framing
			while ((nl = this.buf.indexOf("\n")) !== -1) {
				const line = this.buf.slice(0, nl);
				this.buf = this.buf.slice(nl + 1);
				if (line.trim()) {
					try {
						this.onMessage(JSON.parse(line));
					} catch {
						/* ignore malformed */
					}
				}
			}
		});
		s.on("close", () => {
			this.sock = null;
		});
		s.on("error", () => {});
	}

	private onMessage(m: Record<string, unknown>): void {
		switch (m.t) {
			case "hello": {
				const terminals = (m.terminals as { terminalId: string }[]) ?? [];
				this.live = new Set(terminals.map((t) => t.terminalId));
				this.emit("attached", terminals);
				break;
			}
			case "data":
				this.emit("data", {
					terminalId: m.terminalId,
					data: unb64(m.data as string),
					seq: (m.seq as number) ?? 0,
				});
				break;
			case "exit":
				this.live.delete(m.terminalId as string);
				this.emit("exit", {
					terminalId: m.terminalId,
					exitCode: m.exitCode,
				});
				break;
			case "snapshot":
			case "list": {
				const resolve = this.pending.get(m.id as number);
				if (resolve) {
					this.pending.delete(m.id as number);
					resolve(m);
				}
				break;
			}
			default:
				break;
		}
	}

	private send(o: Record<string, unknown>): void {
		const line = `${JSON.stringify(o)}\n`;
		if (this.sock) {
			this.sock.write(line);
			return;
		}
		// Daemon went away (idle-exit / crash): queue and reconnect (respawning
		// the daemon if needed), then flush. This is why "Start" works again even
		// after the daemon has been gone.
		this.outbox.push(line);
		void this.ensureConnected();
	}

	private async ensureConnected(): Promise<void> {
		if (this.connecting) return;
		if (this.sock) return;
		this.connecting = true;
		try {
			await this.connect();
		} catch (err) {
			console.error("[ateam] PTY daemon reconnect failed:", err);
		} finally {
			this.connecting = false;
		}
		this.flush();
	}

	private flush(): void {
		const sock = this.sock;
		if (!sock || this.outbox.length === 0) return;
		const queued = this.outbox;
		this.outbox = [];
		for (const line of queued) sock.write(line);
	}

	private request(o: Record<string, unknown>): Promise<Record<string, unknown>> {
		const id = ++this.reqId;
		return new Promise((resolve) => {
			this.pending.set(id, resolve);
			this.send({ ...o, id });
			setTimeout(() => {
				if (this.pending.delete(id)) resolve({});
			}, 4000);
		});
	}

	private spawnDaemon(): void {
		const child = spawnProc(this.electronExec, [this.daemonPath], {
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: "1",
				ATEAM_PTY_SOCK: this.sockPath,
			},
			detached: true,
			stdio: "ignore",
		});
		child.unref();
	}

	spawn(o: SpawnOptions): string {
		this.live.add(o.terminalId);
		this.send({
			t: "spawn",
			terminalId: o.terminalId,
			shell: o.shell,
			args: o.args,
			cwd: o.cwd,
			env: o.env,
			cols: o.cols,
			rows: o.rows,
			agentId: o.agentId,
		});
		return o.terminalId;
	}

	write(terminalId: string, data: string): void {
		this.send({ t: "write", terminalId, data: b64(data) });
	}

	resize(terminalId: string, cols: number, rows: number): void {
		this.send({ t: "resize", terminalId, cols, rows });
	}

	kill(terminalId: string): void {
		this.live.delete(terminalId);
		this.send({ t: "kill", terminalId });
	}

	has(terminalId: string): boolean {
		return this.live.has(terminalId);
	}

	async snapshot(terminalId: string): Promise<{ data: string; seq: number }> {
		const r = await this.request({ t: "snapshot", terminalId });
		return {
			data: r.data ? unb64(r.data as string) : "",
			seq: (r.seq as number) ?? 0,
		};
	}

	async list(): Promise<{ terminalId: string; agentId: string; cwd: string }[]> {
		const r = await this.request({ t: "list" });
		return (r.terminals as { terminalId: string; agentId: string; cwd: string }[]) ?? [];
	}

	/** Sessions are owned by the daemon and survive app restarts — never killed here. */
	killAll(): void {}

	disconnect(): void {
		this.sock?.end();
		this.sock = null;
	}
}
