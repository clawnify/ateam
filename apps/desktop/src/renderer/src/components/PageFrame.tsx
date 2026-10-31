// An agent's page (show_page, or ask_user's `page`), drawn in a sandboxed
// frame served by main (main/pages.ts, which says what the page may and may not
// do). Inline it fits its content up to a cap; Expand shows it over the window,
// in a second frame drawn outside the chat or panel it sits in.
//
// The page reaches this window by postMessage alone: its height, and for a
// question's page an answer (ateam.answer). Answers come only through the
// port main's prelude sends first, which sends only on a real click or key
// press in the frame (main/pages.ts says why), so a page cannot answer its own
// question: whatever else it posts is ignored.
import { FileText, Maximize2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { pageUrl } from "../../../shared/pages";

type Answer = string | string[];

const isAnswer = (v: unknown): v is Answer =>
	typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"));

function Frame({
	taskId,
	pageId,
	title,
	fill,
	maxHeight,
	onAnswer,
}: {
	taskId: string;
	pageId: string;
	title: string;
	/** Take the whole box (the expanded view) instead of fitting the content. */
	fill?: boolean;
	maxHeight: number;
	onAnswer?: (value: Answer) => void;
}) {
	const ref = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(120);
	// The handler changes with its parent's render; the listener stays put.
	const answer = useRef(onAnswer);
	answer.current = onAnswer;

	// The prelude's port; once taken, a later one is the page's own and ignored.
	const port = useRef<MessagePort | null>(null);

	// A layout effect, so the listener is up in the same task that inserts the
	// frame: the prelude's port can never arrive before it and be missed.
	useLayoutEffect(() => {
		const onMessage = (e: MessageEvent) => {
			const frame = ref.current;
			if (!frame || e.source !== frame.contentWindow) return;
			const m = e.data as { ateamPage?: number; type?: string; height?: unknown };
			if (m?.ateamPage !== 1) return;
			if (m.type === "height" && typeof m.height === "number" && m.height > 0)
				setHeight(Math.ceil(m.height));
			else if (m.type === "port" && e.ports[0] && !port.current) {
				port.current = e.ports[0];
				port.current.onmessage = (ev: MessageEvent) => {
					const a = ev.data as { type?: string; value?: unknown };
					if (a?.type === "answer" && isAnswer(a.value)) answer.current?.(a.value);
				};
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, []);
	useEffect(() => () => port.current?.close(), []);

	return (
		<iframe
			ref={ref}
			className="page-frame"
			title={title}
			src={pageUrl(taskId, pageId)}
			sandbox="allow-scripts"
			referrerPolicy="no-referrer"
			style={fill ? undefined : { height: Math.min(Math.max(height, 40), maxHeight) }}
		/>
	);
}

export function PageFrame({
	taskId,
	pageId,
	title,
	maxHeight = 480,
	collapsed,
	onAnswer,
}: {
	taskId: string;
	pageId: string;
	title: string;
	maxHeight?: number;
	/** Only the title bar, opening the page over the window (the task panel,
	 *  where the terminal keeps the room). */
	collapsed?: boolean;
	/** A question's page: what its buttons answer goes here. */
	onAnswer?: (value: Answer) => void;
}) {
	const [expanded, setExpanded] = useState(false);

	useEffect(() => {
		if (!expanded) return;
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && setExpanded(false);
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [expanded]);

	const answer = onAnswer
		? (v: Answer) => {
				setExpanded(false);
				onAnswer(v);
			}
		: undefined;

	return (
		<div className={`page${collapsed ? " collapsed" : ""}`}>
			{collapsed ? (
				// Only the bar is showing, so the whole bar opens the page.
				<button
					type="button"
					className="page-head page-open"
					aria-label={`Open ${title}`}
					onClick={() => setExpanded(true)}
				>
					<FileText size={12} className="page-icon" />
					<span className="page-title">{title}</span>
					<Maximize2 size={12} className="page-icon" />
				</button>
			) : (
				<div className="page-head">
					<FileText size={12} className="page-icon" />
					<span className="page-title">{title}</span>
					<button
						type="button"
						className="iconbtn"
						title="Expand"
						aria-label={`Expand ${title}`}
						onClick={() => setExpanded(true)}
					>
						<Maximize2 size={12} />
					</button>
				</div>
			)}
			{/* Stays while expanded: taking it out would change the height of
			    whatever it sits in, and a chat would lose its scroll position. */}
			{!collapsed && (
				<Frame
					key={pageId}
					taskId={taskId}
					pageId={pageId}
					title={title}
					maxHeight={maxHeight}
					onAnswer={answer}
				/>
			)}
			{expanded &&
				createPortal(
					<div className="overlay">
						<div className="page-expanded" role="dialog" aria-modal="true" aria-label={title}>
							<div className="page-head">
								<span className="page-title">{title}</span>
								<button
									type="button"
									className="iconbtn"
									title="Close (Esc)"
									aria-label="Close"
									onClick={() => setExpanded(false)}
								>
									<X size={13} />
								</button>
							</div>
							<Frame
								key={pageId}
								taskId={taskId}
								pageId={pageId}
								title={title}
								fill
								maxHeight={Number.POSITIVE_INFINITY}
								onAnswer={answer}
							/>
						</div>
					</div>,
					document.body,
				)}
		</div>
	);
}
