// A box's GitHub access on the phone (githubAccess:*, v25): who the box signs in
// as and with what kind of token, per project whether it can push, and connecting
// a token with an ordinary text field, where long-press Paste works, instead of the
// hidden `gh auth login` prompt in the box terminal. Same words as the desktop's
// GithubAccess.tsx (@ateam/protocol github-access.ts).
//
// The token is typed here, sent to the box once, and cleared from state as soon as
// the box has it. Nothing ever sends it back.

import {
	type AteamApi,
	broadTokenRevokeNote,
	cleanGithubToken,
	FINE_GRAINED_REPO_HINT,
	fineGrainedTokenUrl,
	type GithubAccessDTO,
	githubAccessProblem,
	githubAccessSummary,
	githubTokenWouldHelp,
	mostCommonOwner,
	pastedTokenLabel,
	type RepoAccessDTO,
	repoAccessLabel,
	repoVerdictHint,
} from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import { useCallback, useEffect, useState } from "react";
import {
	ActivityIndicator,
	Linking,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { C, CONTENT_MAX } from "./theme";

type Loaded =
	| { state: "loading" }
	| { state: "error"; message: string }
	| { state: "ready"; access: GithubAccessDTO };

export function GithubAccessScreen({
	api,
	boxLabel,
	supported,
	onClose,
	onUpdateBox,
	updating,
}: {
	api: AteamApi;
	/** How the box is named in sentences. */
	boxLabel: string;
	/** The box's engine answers githubAccess:* (v25). */
	supported: boolean;
	onClose: () => void;
	/** A box older than this app signs in in its terminal; updating it brings this screen. */
	onUpdateBox: () => void;
	updating: boolean;
}) {
	const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
	const [checks, setChecks] = useState<RepoAccessDTO[] | null>(null);
	const [checking, setChecking] = useState(false);
	const [formOpen, setFormOpen] = useState(false);
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoaded({ state: "loading" });
		try {
			setLoaded({ state: "ready", access: await api.githubAccess.status() });
		} catch (e) {
			setLoaded({ state: "error", message: e instanceof Error ? e.message : String(e) });
			return;
		}
		setChecking(true);
		try {
			setChecks(await api.githubAccess.check());
		} catch {
			setChecks(null); // the access line still stands on its own
		} finally {
			setChecking(false);
		}
	}, [api]);

	useEffect(() => {
		if (supported) void load();
	}, [supported, load]);

	const connect = async () => {
		const clean = cleanGithubToken(token);
		if (!clean) {
			setError(
				"That doesn't look like a GitHub token. Copy the whole token: it starts with github_pat_.",
			);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const access = await api.githubAccess.connect(clean);
			setToken("");
			setFormOpen(false);
			setLoaded({ state: "ready", access });
			setChecks(await api.githubAccess.check().catch(() => null));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const header = (
		<View style={styles.header}>
			<Pressable onPress={onClose} hitSlop={8} accessibilityRole="button">
				<Text style={styles.back}>Back</Text>
			</Pressable>
			<Text style={styles.title}>GitHub</Text>
			<Text style={styles.back} />
		</View>
	);

	if (!supported) {
		return (
			<View style={styles.root}>
				{header}
				<View style={styles.column}>
					<Text style={styles.body}>
						This box's Ateam is too old to sign in to GitHub from here. Update the box, or run gh
						auth login in its terminal.
					</Text>
					<Pressable
						style={[styles.primary, updating && styles.disabled]}
						onPress={onUpdateBox}
						disabled={updating}
						accessibilityRole="button"
					>
						<Text style={styles.primaryText}>{updating ? "Updating…" : "Update box"}</Text>
					</Pressable>
				</View>
			</View>
		);
	}

	if (loaded.state !== "ready") {
		return (
			<View style={styles.root}>
				{header}
				<View style={styles.column}>
					{loaded.state === "loading" ? (
						<ActivityIndicator color={C.ink} />
					) : (
						<>
							<Text style={styles.problem}>
								Couldn't read GitHub access on {boxLabel}: {loaded.message}
							</Text>
							<Pressable style={styles.secondary} onPress={() => void load()}>
								<Text style={styles.secondaryText}>Try again</Text>
							</Pressable>
						</>
					)}
				</View>
			</View>
		);
	}

	const access = loaded.access;
	const problem = githubAccessProblem(access);
	const showForm = formOpen || githubTokenWouldHelp(access);
	const owner = mostCommonOwner(checks?.map((c) => c.repo) ?? []) ?? access.gh?.login ?? null;
	const pasted = pastedTokenLabel(token);
	const hint = repoVerdictHint(access, checks ?? []);

	return (
		<View style={styles.root}>
			{header}
			<ScrollView
				contentContainerStyle={styles.scroll}
				keyboardShouldPersistTaps="handled"
				keyboardDismissMode="interactive"
			>
				<View style={styles.column}>
					<Text style={styles.box}>{boxLabel}</Text>
					<Text style={styles.body}>{githubAccessSummary(access)}</Text>
					{problem ? <Text style={styles.problem}>{problem}</Text> : null}
					{access.unverified ? <Text style={styles.note}>{access.unverified}</Text> : null}

					{checks && checks.length > 0 ? (
						<View style={styles.repos}>
							<Text style={styles.label}>Projects on this box</Text>
							{checks.map((c) => (
								<View key={c.repo} style={styles.repo}>
									<Text style={styles.repoName} numberOfLines={1}>
										{c.repo}
									</Text>
									<Text
										style={[
											styles.verdict,
											c.access === "push" && styles.verdictPush,
											c.access === "read" && styles.verdictRead,
											c.access === "none" && styles.verdictNone,
										]}
									>
										{repoAccessLabel(c.access)}
									</Text>
								</View>
							))}
						</View>
					) : null}
					{checking && !checks ? (
						<Text style={styles.note}>Checking which projects it can push to…</Text>
					) : null}
					{hint === FINE_GRAINED_REPO_HINT ? (
						<Pressable
							onPress={() =>
								void Linking.openURL("https://github.com/settings/personal-access-tokens")
							}
						>
							<Text style={styles.note}>
								{hint} <Text style={styles.link}>Your tokens on GitHub</Text>
							</Text>
						</Pressable>
					) : hint ? (
						<Text style={styles.note}>{hint}</Text>
					) : null}

					{!showForm && access.ghInstalled && access.gh?.source !== "env" ? (
						<Pressable style={styles.secondary} onPress={() => setFormOpen(true)}>
							<Text style={styles.secondaryText}>Use a different token</Text>
						</Pressable>
					) : null}

					{showForm ? (
						<View style={styles.form}>
							<View style={styles.step}>
								<Text style={styles.stepN}>1</Text>
								<View style={styles.stepBody}>
									<Pressable
										style={styles.secondary}
										onPress={() =>
											void Linking.openURL(fineGrainedTokenUrl({ box: boxLabel, owner }))
										}
										accessibilityRole="link"
									>
										<Text style={styles.secondaryText}>Create a token on GitHub</Text>
										<Feather name="external-link" size={13} color={C.ink} />
									</Pressable>
									<Text style={styles.note}>
										Ateam fills in the name, 90 days and its permissions. Choose the repositories
										this box works on, then Generate token and copy it.
									</Text>
								</View>
							</View>
							<View style={styles.step}>
								<Text style={styles.stepN}>2</Text>
								<View style={styles.stepBody}>
									<TextInput
										style={styles.input}
										value={token}
										onChangeText={(v) => {
											setToken(v);
											setError(null);
										}}
										placeholder="Paste the token (github_pat_…)"
										placeholderTextColor={C.faint}
										secureTextEntry
										autoCapitalize="none"
										autoCorrect={false}
										autoComplete="off"
										textContentType="none"
										spellCheck={false}
										editable={!busy}
										returnKeyType="go"
										onSubmitEditing={() => {
											if (token.trim()) void connect();
										}}
										accessibilityLabel={`GitHub token for ${boxLabel}`}
									/>
									{pasted ? <Text style={styles.note}>{pasted}</Text> : null}
									<Pressable
										style={[styles.primary, (busy || !token.trim()) && styles.disabled]}
										onPress={() => void connect()}
										disabled={busy || !token.trim()}
										accessibilityRole="button"
									>
										<Text style={styles.primaryText}>{busy ? "Connecting…" : "Connect"}</Text>
									</Pressable>
								</View>
							</View>
							{error ? <Text style={styles.problem}>{error}</Text> : null}
							<Text style={styles.note}>
								The token goes to {boxLabel} only, where gh keeps it. Agents there can read it,
								which is why it should reach only this box's repositories.
							</Text>
							{broadTokenRevokeNote(access) ? (
								<Text style={styles.note}>{broadTokenRevokeNote(access)}</Text>
							) : null}
							{/* Opened by hand on a box that needs nothing: let it close again. */}
							{!githubTokenWouldHelp(access) ? (
								<Pressable
									onPress={() => {
										setFormOpen(false);
										setToken("");
										setError(null);
									}}
									disabled={busy}
									hitSlop={8}
								>
									<Text style={styles.note}>Keep the current token</Text>
								</Pressable>
							) : null}
						</View>
					) : null}
				</View>
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg, paddingTop: 60 },
	header: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 16,
		paddingBottom: 12,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
	},
	back: { color: C.muted, fontSize: 15, width: 54 },
	title: { color: C.ink, fontSize: 16, fontWeight: "700" },
	scroll: { paddingBottom: 60 },
	column: {
		width: "100%",
		maxWidth: CONTENT_MAX,
		alignSelf: "center",
		paddingHorizontal: 16,
		paddingTop: 16,
		gap: 12,
	},
	box: { color: C.faint, fontSize: 12 },
	body: { color: C.ink, fontSize: 15, lineHeight: 21 },
	problem: { color: C.amber, fontSize: 13, lineHeight: 19 },
	note: { color: C.muted, fontSize: 12, lineHeight: 17 },
	link: { color: C.ink, textDecorationLine: "underline" },
	label: { color: C.faint, fontSize: 12, paddingBottom: 2 },
	repos: { gap: 6 },
	repo: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
	repoName: { color: C.ink, fontSize: 13, flexShrink: 1, fontFamily: "Menlo" },
	verdict: { color: C.muted, fontSize: 13, flexShrink: 0 },
	verdictPush: { color: C.ink },
	verdictRead: { color: C.amber },
	verdictNone: { color: C.red },
	form: {
		gap: 14,
		padding: 14,
		borderRadius: 10,
		borderWidth: 1,
		borderColor: C.line,
		backgroundColor: C.surface,
	},
	step: { flexDirection: "row", gap: 10 },
	stepN: {
		color: C.muted,
		fontSize: 11,
		width: 20,
		height: 20,
		lineHeight: 18,
		textAlign: "center",
		borderRadius: 10,
		borderWidth: 1,
		borderColor: C.line,
		overflow: "hidden",
		marginTop: 6,
	},
	stepBody: { flex: 1, gap: 8, alignItems: "flex-start" },
	input: {
		alignSelf: "stretch",
		color: C.ink,
		backgroundColor: C.sunken,
		fontSize: 15,
		paddingHorizontal: 12,
		paddingVertical: 10,
		borderRadius: 8,
	},
	primary: {
		backgroundColor: C.ink,
		paddingHorizontal: 16,
		paddingVertical: 10,
		borderRadius: 8,
		alignItems: "center",
	},
	primaryText: { color: "#15151a", fontSize: 14, fontWeight: "700" },
	secondary: {
		flexDirection: "row",
		alignItems: "center",
		alignSelf: "flex-start",
		gap: 8,
		paddingHorizontal: 14,
		paddingVertical: 9,
		borderRadius: 8,
		borderWidth: 1,
		borderColor: C.line,
	},
	secondaryText: { color: C.ink, fontSize: 13, fontWeight: "600" },
	disabled: { opacity: 0.5 },
});
