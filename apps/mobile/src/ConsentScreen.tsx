// The disclosure shown before the app's FIRST connection to a box. Apple's guidelines
// 5.1.1(i)/5.1.2(i) require three things before user data may be transmitted: say what
// is sent, say who it reaches, and get permission, and they state explicitly that
// putting it in a privacy policy alone is not sufficient. So this is a blocking screen
// on the path to connecting, not a link.
//
// It is deliberately honest about the two hops, because that is the part a user cannot
// infer: their input goes to a machine THEY run, and the agent on that machine then
// talks to Anthropic or OpenAI under THEIR account. Ateam is not in the middle of
// either hop, and we operate no server at all.
//
// Demo mode is offered as the decline path rather than a dead end: it is fully offline,
// so someone who does not consent can still see the whole app.

import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

const C = {
	bg: "#0c0c0e",
	surface: "#141418",
	line: "#2a2a33",
	ink: "#e6e6ea",
	muted: "#9a9aa6",
	faint: "#6a6a75",
};

const POLICY_URL = "https://github.com/clawnify/ateam/blob/main/PRIVACY.md";

/** One "what goes where" row: a short label and the plain-language detail under it. */
function Point({ title, body }: { title: string; body: string }): React.JSX.Element {
	return (
		<View style={styles.point}>
			<Text style={styles.pointTitle}>{title}</Text>
			<Text style={styles.pointBody}>{body}</Text>
		</View>
	);
}

export function ConsentScreen({
	onAgree,
	onDemo,
}: {
	onAgree: () => void;
	onDemo: () => void;
}): React.JSX.Element {
	return (
		<View style={styles.root}>
			<ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
				<View style={styles.column}>
					<Text style={styles.title}>Before you connect</Text>
					<Text style={styles.lede}>
						Ateam Go is a remote control for a computer you run yourself. Here is exactly where what
						you type ends up.
					</Text>

					<View style={styles.card}>
						<Point
							title="What is sent"
							body="Your prompts and keystrokes, the terminal input and output of the tasks you open, and any photo you choose to attach."
						/>
						<Point
							title="Where it goes"
							body="Only to the machine you enter on the next screen, over your own private network. Clawnify runs no server in between and receives none of it."
						/>
						<Point
							title="What happens there"
							body="The AI coding agents you installed on that machine (such as Claude Code or Codex) send your prompts and code to their providers, Anthropic or OpenAI, using the accounts you hold with them and under their privacy policies."
						/>
					</View>

					<Pressable
						onPress={() => void Linking.openURL(POLICY_URL)}
						hitSlop={8}
						accessibilityRole="link"
						accessibilityLabel="Read the full privacy policy"
					>
						<Text style={styles.link}>Read the full privacy policy</Text>
					</Pressable>

					<Pressable
						style={styles.agreeBtn}
						onPress={onAgree}
						accessibilityRole="button"
						accessibilityLabel="Agree and continue to the connection screen"
					>
						<Text style={styles.agreeText}>Agree and continue</Text>
					</Pressable>

					<Pressable
						style={styles.demoBtn}
						onPress={onDemo}
						accessibilityRole="button"
						accessibilityLabel="Try the offline demo instead, which sends nothing"
					>
						<Text style={styles.demoText}>Try the demo instead</Text>
					</Pressable>

					<Text style={styles.note}>
						The demo is entirely offline: it makes no network connection and sends nothing anywhere.
						You can look around first and agree to this later.
					</Text>
				</View>
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg },
	content: { padding: 20, paddingTop: 72, paddingBottom: 40 },
	column: { width: "100%", maxWidth: 560, alignSelf: "center" },
	title: { color: C.ink, fontSize: 26, fontWeight: "700", letterSpacing: -0.4 },
	lede: { color: C.muted, fontSize: 15, lineHeight: 22, marginTop: 10 },
	card: {
		marginTop: 22,
		backgroundColor: C.surface,
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 12,
		paddingHorizontal: 16,
		paddingVertical: 4,
	},
	point: {
		paddingVertical: 14,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: C.line,
	},
	pointTitle: { color: C.ink, fontSize: 13, fontWeight: "700" },
	pointBody: { color: C.muted, fontSize: 14, lineHeight: 21, marginTop: 5 },
	link: {
		color: C.ink,
		fontSize: 14,
		fontWeight: "600",
		marginTop: 18,
		textDecorationLine: "underline",
	},
	agreeBtn: {
		marginTop: 22,
		backgroundColor: C.ink,
		borderRadius: 10,
		paddingVertical: 14,
		alignItems: "center",
	},
	agreeText: { color: "#15151a", fontSize: 15, fontWeight: "700" },
	demoBtn: {
		marginTop: 12,
		borderWidth: 1,
		borderColor: C.line,
		backgroundColor: C.surface,
		borderRadius: 10,
		paddingVertical: 13,
		alignItems: "center",
	},
	demoText: { color: C.ink, fontSize: 14, fontWeight: "700" },
	note: { color: C.faint, fontSize: 12, lineHeight: 18, marginTop: 18 },
});
