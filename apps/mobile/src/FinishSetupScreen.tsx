// What's left once a box this phone created answers (src/useBoxCreation.ts): signing in
// to the coding agent it installed, GitHub, a first project, and, optionally, the box's
// AI keys. Each opens its own screen and comes back here; Done goes to the board. They
// stay on the box's card in Boxes (its terminal, GitHub and key buttons) for later.
import { AGENT_INSTALLS, type InstallableAgent } from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import type { ComponentProps } from "react";
import { Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native";
import { C, CONTENT_MAX } from "./theme";

function Step({
	icon,
	title,
	body,
	onPress,
}: {
	icon: ComponentProps<typeof Feather>["name"];
	title: string;
	body: string;
	onPress: () => void;
}) {
	return (
		<Pressable
			style={({ pressed }) => [styles.step, pressed && styles.pressed]}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={`${title}. ${body}`}
		>
			<Feather name={icon} size={18} color={C.ink} />
			<View style={styles.stepText}>
				<Text style={styles.stepTitle}>{title}</Text>
				<Text style={styles.stepBody}>{body}</Text>
			</View>
			<Feather name="chevron-right" size={16} color={C.muted} />
		</Pressable>
	);
}

export function FinishSetupScreen({
	name,
	agents,
	onSignIn,
	onTerminal,
	onDotfiles,
	onGithub,
	onAiKeys,
	onAddProject,
	onDone,
}: {
	name: string;
	/** The agents the box reports, of those Ateam installs. */
	agents: InstallableAgent[];
	/** Open the box's terminal with this command typed in. */
	onSignIn: (command: string) => void;
	onTerminal: () => void;
	onDotfiles: () => void;
	onGithub: () => void;
	/** The box's AI keys page (AiKeysScreen). */
	onAiKeys: () => void;
	onAddProject: () => void;
	onDone: () => void;
}) {
	return (
		<View style={styles.root}>
			<StatusBar barStyle="light-content" backgroundColor={C.bg} />
			<View style={styles.navBar}>
				<Text style={styles.navTitle}>Finish setting up</Text>
				<View style={styles.spacer} />
				<Pressable style={styles.done} onPress={onDone} hitSlop={6} accessibilityRole="button">
					<Text style={styles.doneText}>Done</Text>
				</Pressable>
			</View>
			<ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
				<View style={styles.column}>
					<Text style={styles.intro}>
						{name} is up. Before its first task, sign in to an agent on it, and connect GitHub so
						its agents can clone and push.
					</Text>
					{agents.length ? (
						agents.map((a) => (
							<Step
								key={a}
								icon="log-in"
								title={`Sign in to ${AGENT_INSTALLS[a].label}`}
								body={`Opens the box's terminal running ${AGENT_INSTALLS[a].login}: open its link, sign in, and come back.`}
								onPress={() => onSignIn(AGENT_INSTALLS[a].login)}
							/>
						))
					) : (
						<Step
							icon="terminal"
							title="Install a coding agent"
							body="None is on the box yet. Install one from its terminal, for example Claude Code."
							onPress={onTerminal}
						/>
					)}
					<Step
						icon="github"
						title="Connect GitHub"
						body="A token for the repos this box works on. It also gives commits your name."
						onPress={onGithub}
					/>
					<Step
						icon="file-text"
						title="Apply dotfiles"
						body="Optional. Preview your repository and run its install script on this box."
						onPress={onDotfiles}
					/>
					<Step
						icon="folder-plus"
						title="Add a project"
						body="Bring one over from GitHub, or start a new one."
						onPress={onAddProject}
					/>
					<Step
						icon="key"
						title="Add AI keys"
						body="Optional. An OpenAI key lets you call the Lead, and sorts finished tasks into Needs you."
						onPress={onAiKeys}
					/>
				</View>
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg, paddingTop: 60 },
	navBar: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingHorizontal: 18,
		paddingBottom: 14,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
	},
	navTitle: { color: C.ink, fontSize: 17, fontWeight: "700", letterSpacing: -0.2 },
	spacer: { flex: 1 },
	done: {
		height: 32,
		paddingHorizontal: 14,
		borderRadius: 16,
		backgroundColor: C.ink,
		alignItems: "center",
		justifyContent: "center",
	},
	doneText: { color: C.bg, fontSize: 14, fontWeight: "700" },
	content: { padding: 16, paddingTop: 20, paddingBottom: 40 },
	column: { width: "100%", maxWidth: CONTENT_MAX, alignSelf: "center", gap: 10 },
	intro: { color: C.muted, fontSize: 14, lineHeight: 20, marginBottom: 4 },
	step: {
		flexDirection: "row",
		alignItems: "center",
		gap: 14,
		paddingHorizontal: 16,
		paddingVertical: 14,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: C.line,
		backgroundColor: C.surface,
	},
	pressed: { opacity: 0.7 },
	stepText: { flex: 1, gap: 3 },
	stepTitle: { color: C.ink, fontSize: 15, fontWeight: "600" },
	stepBody: { color: C.muted, fontSize: 12, lineHeight: 17 },
});
