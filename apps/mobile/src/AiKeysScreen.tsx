// A box's AI keys on the phone: the OpenAI key (calls with the Lead, Needs you
// sorting) and an optional OpenRouter one, sent to that box with credentials:update.
// Without this a box made from the phone (CreateBoxScreen) could only get keys from a
// Mac's Settings → AI. The desktop's fields are the same keys (SettingsPanel.tsx).
//
// A key is typed here, sent to the box once, and cleared from state as soon as the
// box has it. Nothing sends it back: the box answers only whether one is set and its
// last four characters.
import type { AteamApi, CredentialStatus, CredentialsResult } from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import { useCallback, useEffect, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	Linking,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { AI_KEY_FIELDS, type AiKeyField, cleanKey, savedKeyLine, wrongField } from "./ai-keys";
import { C, CONTENT_MAX } from "./theme";

type Loaded =
	| { state: "loading" }
	| { state: "error"; message: string }
	| { state: "ready"; keys: CredentialsResult };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function AiKeysScreen({
	api,
	boxLabel,
	onClose,
	onUpdateBox,
	updating,
}: {
	api: AteamApi;
	/** How the box is named in sentences. */
	boxLabel: string;
	onClose: () => void;
	/** A box older than v31 can't use an OpenAI key; updating it can. */
	onUpdateBox: () => void;
	updating: boolean;
}) {
	const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });

	const load = useCallback(async () => {
		setLoaded({ state: "loading" });
		try {
			setLoaded({ state: "ready", keys: await api.credentials.get() });
		} catch (e) {
			setLoaded({ state: "error", message: message(e) });
		}
	}, [api]);

	useEffect(() => {
		void load();
	}, [load]);

	const header = (
		<View style={styles.header}>
			<Pressable onPress={onClose} hitSlop={8} accessibilityRole="button">
				<Text style={styles.back}>Back</Text>
			</Pressable>
			<Text style={styles.title}>AI keys</Text>
			<Text style={styles.back} />
		</View>
	);

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
								Couldn't read the keys on {boxLabel}: {loaded.message}
							</Text>
							<Pressable
								style={styles.secondary}
								onPress={() => void load()}
								accessibilityRole="button"
							>
								<Text style={styles.secondaryText}>Try again</Text>
							</Pressable>
						</>
					)}
				</View>
			</View>
		);
	}

	const save = async (patch: Parameters<AteamApi["credentials"]["update"]>[0]) => {
		const keys = await api.credentials.update(patch);
		setLoaded({ state: "ready", keys });
	};

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
					<Text style={styles.body}>
						Optional. {boxLabel} uses these keys itself, for what each one says below.
					</Text>
					{AI_KEY_FIELDS.map((field) => (
						<KeyRow
							key={field.provider}
							field={field}
							status={loaded.keys[field.provider]}
							boxLabel={boxLabel}
							onSave={(key) => save({ [field.field]: key })}
							onUpdateBox={onUpdateBox}
							updating={updating}
						/>
					))}
					<Text style={styles.note}>
						Each key goes to {boxLabel} only and stays there: this phone doesn't keep it. Your
						agent's last message and your reply go to that provider. If your Mac syncs its settings
						to your boxes, its keys replace these when it connects.
					</Text>
				</View>
			</ScrollView>
		</View>
	);
}

function KeyRow({
	field,
	status,
	boxLabel,
	onSave,
	onUpdateBox,
	updating,
}: {
	field: AiKeyField;
	/** Undefined from a box too old for this key (OpenAI before v31). */
	status: CredentialStatus | undefined;
	boxLabel: string;
	/** Saves the key, or removes it with null; throws what the box said. */
	onSave: (key: string | null) => Promise<void>;
	onUpdateBox: () => void;
	updating: boolean;
}) {
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const key = cleanKey(draft);
	const misplaced = key ? wrongField(field.provider, key) : null;

	const run = async (value: string | null) => {
		setBusy(true);
		setError(null);
		try {
			await onSave(value);
			setDraft("");
		} catch (e) {
			setError(message(e));
		} finally {
			setBusy(false);
		}
	};

	const remove = () =>
		Alert.alert(`Remove the ${field.label}?`, `${boxLabel} stops using it.`, [
			{ text: "Cancel", style: "cancel" },
			{ text: "Remove", style: "destructive", onPress: () => void run(null) },
		]);

	return (
		<View style={styles.card}>
			<View style={styles.cardTitleRow}>
				<Text style={styles.cardTitle}>{field.label}</Text>
				{field.optional ? <Text style={styles.optional}>Optional</Text> : null}
				{status?.set ? <Feather name="check" size={15} color={C.ink} /> : null}
			</View>
			<Text style={styles.note}>{field.purpose}</Text>
			{status === undefined ? (
				<>
					<Text style={styles.problem}>
						{boxLabel}'s Ateam is too old to use this key. Update the box first.
					</Text>
					<Pressable
						style={[styles.primary, updating && styles.disabled]}
						onPress={onUpdateBox}
						disabled={updating}
						accessibilityRole="button"
					>
						<Text style={styles.primaryText}>{updating ? "Updating…" : "Update box"}</Text>
					</Pressable>
				</>
			) : status.set ? (
				<View style={styles.saved}>
					<Text style={styles.savedText}>{savedKeyLine(status)}</Text>
					{/* A key from the box's environment can't be removed from here. */}
					{status.source !== "env" ? (
						<Pressable
							onPress={remove}
							disabled={busy}
							hitSlop={8}
							accessibilityRole="button"
							accessibilityLabel={`Remove the ${field.label}`}
						>
							<Text style={styles.removeText}>{busy ? "Removing…" : "Remove"}</Text>
						</Pressable>
					) : null}
				</View>
			) : (
				<>
					<Pressable
						style={styles.secondary}
						onPress={() => void Linking.openURL(field.console.url)}
						accessibilityRole="link"
						accessibilityHint={`Opens ${field.console.path}`}
					>
						<Text style={styles.secondaryText}>Create a key</Text>
						<Feather name="external-link" size={13} color={C.ink} />
					</Pressable>
					<Text style={styles.note}>{field.console.path}</Text>
					<TextInput
						style={styles.input}
						value={draft}
						onChangeText={(v) => {
							setDraft(v);
							setError(null);
						}}
						placeholder={`Paste the key (${field.placeholder})`}
						placeholderTextColor={C.faint}
						secureTextEntry
						autoCapitalize="none"
						autoCorrect={false}
						autoComplete="off"
						textContentType="none"
						spellCheck={false}
						editable={!busy}
						returnKeyType="done"
						onSubmitEditing={() => {
							if (key && !misplaced) void run(key);
						}}
						accessibilityLabel={`${field.label} for ${boxLabel}`}
					/>
					{misplaced ? <Text style={styles.problem}>{misplaced}</Text> : null}
					<Pressable
						style={[styles.primary, (busy || !key || misplaced !== null) && styles.disabled]}
						onPress={() => void run(key)}
						disabled={busy || !key || misplaced !== null}
						accessibilityRole="button"
					>
						<Text style={styles.primaryText}>{busy ? "Saving…" : "Save"}</Text>
					</Pressable>
				</>
			)}
			{error ? <Text style={styles.problem}>{error}</Text> : null}
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
	card: {
		gap: 8,
		padding: 14,
		borderRadius: 10,
		borderWidth: 1,
		borderColor: C.line,
		backgroundColor: C.surface,
		alignItems: "flex-start",
	},
	cardTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
	cardTitle: { color: C.ink, fontSize: 15, fontWeight: "600" },
	optional: { color: C.muted, fontSize: 12 },
	saved: { flexDirection: "row", alignItems: "center", gap: 16 },
	savedText: { color: C.ink, fontSize: 14, fontVariant: ["tabular-nums"] },
	removeText: { color: C.red, fontSize: 14 },
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
