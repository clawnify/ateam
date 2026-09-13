// Attach a terminal view to a task's PTY on the box. Shared by the full terminal
// screen and Mission Control's tiles: attach or restore the conversation,
// then paint the snapshot and stream every later chunk
// in sequence order, buffering what arrives before the view has reported a size.
import type { AteamApi, PtyDataEvent, TaskDTO } from "@ateam/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveTaskPty } from "./resolve-task-pty";

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
	task,
	feed,
	spawnIfNone,
	resizePty,
}: {
	api: AteamApi;
	task: TaskDTO;
	/** Push raw PTY bytes into the terminal view. */
	feed: (data: string) => void;
	/** Allow a shell for tasks without an agent. Tiles pass false. */
	spawnIfNone: boolean;
	/** Whether size reports resize the PTY on the box. */
	resizePty: boolean;
}): TaskPty {
	const { id: taskId, agentId } = task;
	const [terminalId, setTerminalId] = useState<string | null>(null);
	const [status, setStatus] = useState<PtyStatus>("connecting");
	const [detail, setDetail] = useState("resolving session…");

	const buffered = useRef<PtyDataEvent[]>([]);
	const applied = useRef(false);
	const lastSeq = useRef(-1);
	const snapped = useRef(false);
	const lastSize = useRef({ cols: 0, rows: 0 });
	const generation = useRef(0);

	useEffect(() => {
		generation.current++;
		let cancelled = false;
		setTerminalId(null);
		setStatus("connecting");
		setDetail("resolving session…");
		buffered.current = [];
		applied.current = false;
		lastSeq.current = -1;
		snapped.current = false;
		let offData = () => {};
		let offExit = () => {};
		// Restoring also probes the CLI and may scan conversation history.
		const withTimeout = <T>(p: Promise<T>): Promise<T> =>
			new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("Session connection timed out")), 60_000);
				p.then(
					(value) => {
						clearTimeout(timer);
						resolve(value);
					},
					(error) => {
						clearTimeout(timer);
						reject(error);
					},
				);
			});

		(async () => {
			try {
				const id = await withTimeout(
					resolveTaskPty(api, { id: taskId, agentId }, spawnIfNone, () => cancelled),
				);
				if (cancelled) return;
				if (!id) {
					setStatus("none");
					setDetail("no saved session");
					return;
				}
				setDetail("attached to session");
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
				cancelled = true;
				setStatus("error");
				setDetail(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			cancelled = true;
			generation.current++;
			offData();
			offExit();
		};
	}, [api, taskId, agentId, feed, spawnIfNone]);

	const onSizeChange = useCallback(
		async (cols: number, rows: number) => {
			const current = generation.current;
			const id = terminalId;
			if (!id) return;
			lastSize.current = { cols, rows };
			if (resizePty) api.pty.resize(id, cols, rows);
			if (snapped.current) return;
			snapped.current = true;
			try {
				const snap = await api.pty.snapshot(id);
				if (current !== generation.current) return;
				if (snap.data) feed(snap.data);
				lastSeq.current = snap.seq;
				for (const c of buffered.current) {
					if (c.seq > lastSeq.current) {
						lastSeq.current = c.seq;
						feed(c.data);
					}
				}
			} catch (err) {
				if (current === generation.current) {
					setStatus("error");
					setDetail(err instanceof Error ? err.message : String(err));
				}
			} finally {
				if (current === generation.current) {
					buffered.current = [];
					applied.current = true;
				}
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
