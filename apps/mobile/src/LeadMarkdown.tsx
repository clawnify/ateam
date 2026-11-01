// Markdown for the Lead chat, drawn with React Native's own Text and View.
// `marked` only parses (its lexer, pure JS, so no native module); this draws
// the tokens. Nothing in the text can run: there is no HTML renderer, raw HTML
// shows as text, and only http(s) links open, in the system browser.
//
// The Lead writes each task it names as `[label](task:<id>)` (TASK_LINK_SCHEME):
// those draw as a chip that opens the task, like the desktop's.
import { TASK_LINK_SCHEME } from "@ateam/protocol";
import { lexer, type MarkedToken, type Token, type Tokens } from "marked";
import { memo, type ReactNode, useMemo } from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { C } from "./theme";

export interface LeadMarkdownProps {
	text: string;
	/** A `task:` link was tapped: what follows the scheme (the task's id). */
	onTaskLink?: (ref: string) => void;
	/** Whether a `task:` link names a task this phone can open. */
	knowsTask?: (ref: string) => boolean;
}

type Ctx = Pick<LeadMarkdownProps, "onTaskLink" | "knowsTask">;

const MONO = "Menlo";

function inline(tokens: Token[] | undefined, ctx: Ctx, key = "i"): ReactNode[] {
	return (tokens ?? []).map((raw, i) => {
		const t = raw as MarkedToken;
		const k = `${key}.${i}`;
		switch (t.type) {
			case "strong":
				return (
					<Text key={k} style={styles.strong}>
						{inline(t.tokens, ctx, k)}
					</Text>
				);
			case "em":
				return (
					<Text key={k} style={styles.em}>
						{inline(t.tokens, ctx, k)}
					</Text>
				);
			case "del":
				return (
					<Text key={k} style={styles.del}>
						{inline(t.tokens, ctx, k)}
					</Text>
				);
			case "codespan":
				return (
					<Text key={k} style={styles.codespan}>
						{t.text}
					</Text>
				);
			case "br":
				return "\n";
			case "link":
				return link(t, ctx, k);
			case "image":
				// No remote images: the alt text stands in, as a link to the image.
				return link({ ...t, type: "link", tokens: [] } as unknown as Tokens.Link, ctx, k, t.text);
			case "text":
				return t.tokens ? <Text key={k}>{inline(t.tokens, ctx, k)}</Text> : decode(t.text);
			case "escape":
				return t.text;
			default:
				return "raw" in t ? t.raw : "";
		}
	});
}

function link(t: Tokens.Link, ctx: Ctx, key: string, label?: string): ReactNode {
	if (t.href.startsWith(TASK_LINK_SCHEME)) {
		const ref = t.href.slice(TASK_LINK_SCHEME.length);
		const text = label ?? t.text;
		// A task this phone can't open (another box's, or gone) reads as plain words.
		if (!ctx.onTaskLink || (ctx.knowsTask && !ctx.knowsTask(ref)))
			return (
				<Text key={key} style={styles.strong}>
					{text}
				</Text>
			);
		return (
			<Text
				key={key}
				style={styles.chip}
				onPress={() => ctx.onTaskLink?.(ref)}
				accessibilityRole="link"
				accessibilityHint="Opens the task"
			>
				{` ${text} `}
			</Text>
		);
	}
	const safe = /^https?:\/\//i.test(t.href);
	return (
		<Text
			key={key}
			style={safe ? styles.link : undefined}
			onPress={safe ? () => void Linking.openURL(t.href) : undefined}
			accessibilityRole={safe ? "link" : undefined}
		>
			{label ?? (t.tokens.length ? inline(t.tokens, ctx, key) : t.text)}
		</Text>
	);
}

/** marked leaves HTML entities from the source escaped in text tokens. */
function decode(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
}

function blocks(tokens: Token[], ctx: Ctx, key = "b"): ReactNode[] {
	const out: ReactNode[] = [];
	tokens.forEach((raw, i) => {
		const t = raw as MarkedToken;
		const k = `${key}.${i}`;
		switch (t.type) {
			case "space":
			case "def":
				return;
			case "paragraph":
				out.push(
					<Text key={k} style={styles.p} selectable>
						{inline(t.tokens, ctx, k)}
					</Text>,
				);
				return;
			case "text":
				// A tight list item's content comes as text with inline tokens.
				out.push(
					<Text key={k} style={styles.p} selectable>
						{t.tokens ? inline(t.tokens, ctx, k) : decode(t.text)}
					</Text>,
				);
				return;
			case "heading":
				out.push(
					<Text key={k} style={[styles.p, styles.heading]} selectable>
						{inline(t.tokens, ctx, k)}
					</Text>,
				);
				return;
			case "code":
				out.push(
					<ScrollView
						key={k}
						horizontal
						style={styles.code}
						contentContainerStyle={styles.codeInner}
						showsHorizontalScrollIndicator={false}
					>
						<Text style={styles.codeText} selectable>
							{t.text}
						</Text>
					</ScrollView>,
				);
				return;
			case "blockquote":
				out.push(
					<View key={k} style={styles.quote}>
						{blocks(t.tokens, ctx, k)}
					</View>,
				);
				return;
			case "list": {
				const start = typeof t.start === "number" ? t.start : 1;
				out.push(
					<View key={k} style={styles.list}>
						{t.items.map((item, n) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: tokens have no ids; their place in the text is who they are
							<View key={`${k}.${n}`} style={styles.item}>
								<Text style={styles.bullet}>
									{item.task ? (item.checked ? "☑" : "☐") : t.ordered ? `${start + n}.` : "•"}
								</Text>
								<View style={styles.itemBody}>
									{blocks(
										item.tokens.filter((x) => x.type !== "checkbox"),
										ctx,
										`${k}.${n}`,
									)}
								</View>
							</View>
						))}
					</View>,
				);
				return;
			}
			case "hr":
				out.push(<View key={k} style={styles.hr} />);
				return;
			case "table":
				out.push(
					<ScrollView
						key={k}
						horizontal
						style={styles.table}
						showsHorizontalScrollIndicator={false}
					>
						<View>
							{[t.header, ...t.rows].map((row, r) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: tokens have no ids; their place in the text is who they are
								<View key={`${k}.${r}`} style={[styles.tr, r === 0 && styles.th]}>
									{row.map((cell, c) => (
										<Text
											// biome-ignore lint/suspicious/noArrayIndexKey: tokens have no ids; their place in the text is who they are
											key={`${k}.${r}.${c}`}
											style={[styles.td, r === 0 && styles.strong]}
											selectable
										>
											{inline(cell.tokens, ctx, `${k}.${r}.${c}`)}
										</Text>
									))}
								</View>
							))}
						</View>
					</ScrollView>,
				);
				return;
			case "html":
				out.push(
					<Text key={k} style={styles.p} selectable>
						{t.text}
					</Text>,
				);
				return;
			default:
				if ("raw" in t && t.raw.trim())
					out.push(
						<Text key={k} style={styles.p} selectable>
							{t.raw}
						</Text>,
					);
		}
	});
	return out;
}

export const LeadMarkdown = memo(function LeadMarkdown({
	text,
	onTaskLink,
	knowsTask,
}: LeadMarkdownProps) {
	const tokens = useMemo(() => {
		try {
			return lexer(text);
		} catch {
			return null;
		}
	}, [text]);
	if (!tokens)
		return (
			<Text style={styles.p} selectable>
				{text}
			</Text>
		);
	return <View style={styles.root}>{blocks(tokens, { onTaskLink, knowsTask })}</View>;
});

const styles = StyleSheet.create({
	root: { gap: 8 },
	p: { color: C.ink, fontSize: 15, lineHeight: 21 },
	heading: { fontWeight: "700" },
	strong: { fontWeight: "700", color: C.ink },
	em: { fontStyle: "italic" },
	del: { textDecorationLine: "line-through", color: C.muted },
	codespan: { fontFamily: MONO, fontSize: 13, backgroundColor: C.sunken, color: C.ink },
	link: { textDecorationLine: "underline", color: C.ink },
	chip: {
		fontWeight: "600",
		color: C.ink,
		backgroundColor: "rgba(230,230,234,0.14)",
	},
	code: {
		backgroundColor: C.sunken,
		borderRadius: 8,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: C.line,
	},
	codeInner: { padding: 10 },
	codeText: { fontFamily: MONO, fontSize: 12.5, lineHeight: 18, color: C.ink },
	quote: { borderLeftWidth: 2, borderLeftColor: C.line, paddingLeft: 10, gap: 8 },
	list: { gap: 4 },
	item: { flexDirection: "row", gap: 6 },
	bullet: { color: C.muted, fontSize: 15, lineHeight: 21, minWidth: 14 },
	itemBody: { flex: 1, gap: 4 },
	hr: { height: StyleSheet.hairlineWidth, backgroundColor: C.line, marginVertical: 4 },
	table: { borderWidth: StyleSheet.hairlineWidth, borderColor: C.line, borderRadius: 8 },
	tr: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderColor: C.line },
	th: { backgroundColor: C.surface },
	td: { color: C.ink, fontSize: 13, lineHeight: 18, padding: 8, minWidth: 90, maxWidth: 220 },
});
