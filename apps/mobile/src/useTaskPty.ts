// Attach a terminal view to a task's PTY on the box. Shared by the full terminal
// screen and Mission Control's tiles: resolve the PTY (attach-if-live, else spawn
// a shell when allowed), then paint the snapshot and stream every later chunk
// in sequence order, buffering what arrives before the view has reported a size.
import type { AteamApi, PtyDataEvent } from "@ateam/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

export type PtyStatus = "connecting" | "live" | "error" | "none";

export interface TaskPty {
	terminalId: string | null;
	status: PtyStatus;
	/** Progress or error text for the status line. */
	detail: string;
	/** Latest size the view reported; the terminal screen uses it to nudge repaints. */
	lastSize: React.MutableRefObject<{ cols: number; rows: number }>;
	/** The view's first size report is the "ready" signal that triggers the snapshot. */
	onSizeChange: (cols: number, rows: number) => void;
	write: (data: string) => void;
}

export function useTaskPty({
	api,
	taskId,
	feed,
	spawnIfNone,
	resizePty,
}: {
	api: AteamApi;
	taskId: string;
	/** Push raw PTY bytes into the terminal view. */
	feed: (data: string) => void;
	/** Spawn a shell when the task has no live session. Tiles pass false. */
	spawnIfNone: boolean;
	/** Whether size reports resize the PTY on the box. Tiles pass false: the
	 *  agent's real terminal keeps the size the full-screen view gave it. */
	resizePty: boolean;
}): TaskPty {
	const [terminalId, setTerminalId] = useState<string | null>(null);
	const [status, setStatus] = useState<PtyStatus>("connecting");
	const [detail, setDetail] = useState("resolving session…");

	const buffered = useRef<PtyDataEvent[]>([]);
	const applied = useRef(false);
	const lastSeq = useRef(-1);
	const snapped = useRef(false);
	const lastSize = useRef({ cols: 0, rows: 0 });

	useEffect(() => {
		let cancelled = false;
		let offData = () => {};
		let offExit = () => {};
		// The RPC client has no per-call timeout, so a half-open WS (common on mobile
		// over Tailscale) makes a call hang forever with no error. Cap the fast resolve
		// calls so a stall surfaces as an actionable error instead of "resolving…" limbo.
		const withTimeout = <T>(p: Promise<T>, what: string): Promise<T> =>
			Promise.race([
				p,
				new Promise<T>((_, rej) =>
					setTimeout(
						() => rej(new Error(`${what} timed out (connection may have dropped)`)),
						12000,
					),
				),
			]);

		(async () => {
			try {
				const live = await withTimeout(api.pty.listForTask(taskId), "listForTask");
				let id = live[0]?.terminalId ?? null;
				if (!id) {
					if (!spawnIfNone) {
						if (!cancelled) {
							setStatus("none");
							setDetail("no live session");
						}
						return;
					}
					setDetail("starting a shell on the box…");
					id = (await withTimeout(api.pty.spawnShell({ taskId }), "spawnShell")).terminalId;
				} else {
					setDetail("attaching to the live agent…");
				}
				if (cancelled) return;
				offData = api.pty.onData((e) => {
					if (e.terminalId !== id) return;
					if (!applied.current) {
						buffered.current.push(e);
						return;
					}
					if (e.seq > lastSeq.current) {
						lastSeq.current = e.seq;
						feed(e.data);
					}
				});
				offExit = api.pty.onExit((e) => {
					if (e.terminalId === id) setDetail(`session exited (code ${e.exitCode})`);
				});
				setTerminalId(id);
				setStatus("live");
			} catch (err) {
				if (cancelled) return;
				setStatus("error");
				setDetail(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			cancelled = true;
			offData();
			offExit();
		};
	}, [api, taskId, feed, spawnIfNone]);

	const onSizeChange = useCallback(
		async (cols: number, rows: number) => {
			const id = terminalId;
			if (!id) return;
			lastSize.current = { cols, rows };
			if (resizePty) api.pty.resize(id, cols, rows);
			if (snapped.current) return;
			snapped.current = true;
			try {
				const snap = await api.pty.snapshot(id);
				if (snap.data) feed(snap.data);
				lastSeq.current = snap.seq;
				for (const c of buffered.current) {
					if (c.seq > lastSeq.current) {
						lastSeq.current = c.seq;
						feed(c.data);
					}
				}
			} finally {
				buffered.current = [];
				applied.current = true;
			}
		},
		[api, terminalId, feed, resizePty],
	);

	const write = useCallback(
		(data: string) => {
			if (terminalId) api.pty.write(terminalId, data);
		},
		[api, terminalId],
	);

	return { terminalId, status, detail, lastSize, onSizeChange, write };
}
