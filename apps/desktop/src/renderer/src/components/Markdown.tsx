// Markdown an agent wrote (the Lead's replies, a task's question), with
// ```mermaid blocks drawn as diagrams by Pele (Obsidian's renderer, MIT).
//
// Pele turns diagram text into SVG and never into scripts, event handlers or
// HTML labels; with links and images off and no icon or math resolver, nothing
// in its output can run or reach the network (probed with hostile input:
// onerror, javascript: links, <script> labels all come out inert). So the SVG
// is inserted as markup, like its own docs do.
import { PeleError, render } from "pele";
import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

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
	// Inert: a click must not navigate the app's window.
	a: ({ children, href }) => (
		<span className="md-link" title={href}>
			{children}
		</span>
	),
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
		<ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
			{text}
		</ReactMarkdown>
	);
}
