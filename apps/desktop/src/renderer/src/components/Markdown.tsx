// Markdown an agent wrote (the Lead's replies, a task's question), with
// ```mermaid blocks drawn as diagrams by Pele (Obsidian's renderer, MIT).
//
// Pele turns diagram text into SVG and never into scripts, event handlers or
// HTML labels; with links and images off and no icon or math resolver, nothing
// in its output can run or reach the network (probed with hostile input:
// onerror, javascript: links, <script> labels all come out inert). So the SVG
// is inserted as markup, like its own docs do.
import { PeleError, render } from "pele";
import { createContext, memo, type ReactNode, useContext, useMemo } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { TASK_LINK_SCHEME } from "../../../shared/lead";

/** How a `task:` link (the Lead naming a task, `[fix login](task:<id>)`) is
 *  drawn, given what follows the scheme and the link's text. Provided by the
 *  Lead chat; anywhere else such a link stays inert like every other. */
export const TaskLinkContext = createContext<
	((target: string, label: ReactNode) => ReactNode) | null
>(null);

function TaskAwareLink({ href, children }: { href?: string; children?: ReactNode }) {
	const renderTask = useContext(TaskLinkContext);
	if (renderTask && href?.startsWith(TASK_LINK_SCHEME)) {
		const target = href.slice(TASK_LINK_SCHEME.length);
		let decoded = target;
		try {
			decoded = decodeURIComponent(target);
		} catch {
			/* a stray % in what the model wrote: match it as written */
		}
		return renderTask(decoded, children);
	}
	// Inert: a click must not navigate the app's window.
	return (
		<span className="md-link" title={href}>
			{children}
		</span>
	);
}

/** react-markdown's default empties any URL whose scheme it doesn't know, so
 *  a `task:` link would reach TaskAwareLink without its target. Nothing here
 *  navigates (links render as spans or chips), so keeping it is safe. */
const urlTransform = (url: string, key: string) =>
	key === "href" && url.startsWith(TASK_LINK_SCHEME) ? url : defaultUrlTransform(url);

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

/** One diagram, or its source with the reason it could not be drawn. While a
 *  reply streams in, a half-written block lands here too until it closes. */
const Diagram = memo(function Diagram({ source }: { source: string }) {
	const drawn = useMemo((): { svg: string } | { error: string } => {
		try {
			return {
				svg: render(source, { links: false, images: false, fontSize: 13, fontFamily: FONT }).svg,
			};
		} catch (e) {
			return { error: e instanceof PeleError ? e.message : String(e) };
		}
	}, [source]);
	if ("svg" in drawn)
		// biome-ignore lint/security/noDangerouslySetInnerHtml: Pele's SVG is inert (see the header).
		return <div className="diagram" dangerouslySetInnerHTML={{ __html: drawn.svg }} />;
	return (
		<div className="diagram failed">
			<pre>
				<code>{source}</code>
			</pre>
			<div className="diagram-error">{drawn.error}</div>
		</div>
	);
});

const COMPONENTS: Components = {
	a: ({ children, href }) => <TaskAwareLink href={href}>{children}</TaskAwareLink>,
	pre: ({ node, children }) => {
		const code = node?.children[0];
		if (
			code?.type === "element" &&
			code.tagName === "code" &&
			String(code.properties.className ?? "").includes("language-mermaid")
		) {
			const text = code.children.map((c) => (c.type === "text" ? c.value : "")).join("");
			return <Diagram source={text} />;
		}
		return <pre>{children}</pre>;
	},
};

export function Markdown({ text }: { text: string }) {
	return (
		<ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS} urlTransform={urlTransform}>
			{text}
		</ReactMarkdown>
	);
}
