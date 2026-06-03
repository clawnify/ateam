import { EventEmitter } from "node:events";
import * as pty from "node-pty";

interface Session {
	id: string;
	proc: pty.IPty;
	/** Ring buffer of recent output for replay-on-attach. */
	buffer: string;
	exited: boolean;
}

const RING_LIMIT = 200_000; // characters retained for replay

export interface SpawnOptions {
	terminalId: string;
	shell: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	cols?: number;
	rows?: number;
}

/**
 * Owns all node-pty sessions in the main process. Streams output via the
 * "data" event and keeps a per-session ring buffer so a renderer can re-attach
 * (e.g. switching tabs / Mission Control) and replay recent scrollback.
 *
 * A cross-restart daemon (sessions surviving an app restart) is a later phase;
 * for now sessions live for the lifetime of the main process.
 */
export class PtyManager extends EventEmitter {
	private sessions = new Map<string, Session>();

	spawn(opts: SpawnOptions): string {
		const proc = pty.spawn(opts.shell, opts.args, {
			name: "xterm-256color",
			cwd: opts.cwd,
			env: opts.env as { [key: string]: string },
			cols: opts.cols ?? 80,
			rows: opts.rows ?? 24,
		});
		const session: Session = {
			id: opts.terminalId,
			proc,
			buffer: "",
			exited: false,
		};
		this.sessions.set(opts.terminalId, session);

		proc.onData((data) => {
			session.buffer += data;
			if (session.buffer.length > RING_LIMIT) {
				session.buffer = session.buffer.slice(-RING_LIMIT);
			}
			this.emit("data", { terminalId: opts.terminalId, data });
		});
		proc.onExit(({ exitCode }) => {
			session.exited = true;
			this.emit("exit", { terminalId: opts.terminalId, exitCode });
		});

		return opts.terminalId;
	}

	write(terminalId: string, data: string): void {
		this.sessions.get(terminalId)?.proc.write(data);
	}

	resize(terminalId: string, cols: number, rows: number): void {
		const s = this.sessions.get(terminalId);
		if (!s || s.exited) return;
		try {
			s.proc.resize(Math.max(1, cols), Math.max(1, rows));
		} catch {
			/* resize after exit — ignore */
		}
	}

	kill(terminalId: string): void {
		const s = this.sessions.get(terminalId);
		if (s && !s.exited) {
			try {
				s.proc.kill();
			} catch {
				/* already gone */
			}
		}
		this.sessions.delete(terminalId);
	}

	snapshot(terminalId: string): string {
		return this.sessions.get(terminalId)?.buffer ?? "";
	}

	has(terminalId: string): boolean {
		return this.sessions.has(terminalId);
	}

	killAll(): void {
		for (const id of [...this.sessions.keys()]) this.kill(id);
	}
}
