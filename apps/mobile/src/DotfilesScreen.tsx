import {
	type AteamApi,
	type DotfilesConfig,
	type DotfilesStatus,
	dotfilesClient,
	type RpcClient,
} from "@ateam/protocol";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { C, CONTENT_MAX } from "./theme";

// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip ANSI escape sequences from installer output.
const ANSI = /\u001b\[[0-9;]*[a-zA-Z]/g;
const EMPTY: DotfilesConfig = { repository: "", script: "" };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function DotfilesScreen({
	rpc,
	api,
	boxLabel,
	supported,
	onClose,
	onUpdateBox,
	updating,
}: {
	rpc: RpcClient;
	api: AteamApi;
	boxLabel: string;
	supported: boolean;
	onClose: () => void;
	onUpdateBox: () => void;
	updating: boolean;
}) {
	const client = useMemo(() => dotfilesClient(rpc), [rpc]);
	const [status, setStatus] = useState<DotfilesStatus | null>(null);
	const [value, setValue] = useState(EMPTY);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [refresh, setRefresh] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Refresh explicitly retries the status request.
	useEffect(() => {
		if (!supported) return;
		let live = true;
		void client
			.status()
			.then((s) => {
				if (!live) return;
				setStatus(s);
				setValue(s.prepared?.config ?? s.run?.plan.config ?? s.defaultConfig ?? EMPTY);
				setError("");
			})
			.catch((e) => {
				if (live) setError(message(e));
			});
		return () => {
			live = false;
		};
	}, [client, supported, refresh]);
	useEffect(() => {
		if (status?.run?.state !== "running") return;
		let live = true;
		const timer = setInterval(() => {
			void client
				.status()
				.then((s) => {
					if (live) {
						setStatus(s);
						setError("");
					}
				})
				.catch((e) => {
					if (live) setError(message(e));
				});
		}, 1500);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [client, status?.run?.state]);
	const act = async (kind: "preview" | "apply" | "save") => {
		setBusy(kind);
		setError("");
		setNotice("");
		try {
			if (kind === "preview") {
				setStatus((s) => (s ? { ...s, prepared: null } : s));
				const plan = await client.prepare(value);
				setValue(plan.config);
				setStatus((s) => ({
					defaultConfig: s?.defaultConfig ?? null,
					run: s?.run ?? null,
					prepared: plan,
				}));
			} else if (kind === "apply" && status?.prepared)
				setStatus(await client.apply(status.prepared.id));
			else if (kind === "save") {
				await api.settings.update({ engine: { dotfiles: value.repository.trim() ? value : null } });
				setNotice(
					value.repository.trim()
						? "Default saved on this box. Nothing was installed."
						: "Default cleared. Installed files stay on this box.",
				);
			}
		} catch (e) {
			if (kind === "apply") setStatus((s) => (s ? { ...s, prepared: null } : s));
			setError(message(e));
		} finally {
			setBusy(null);
		}
	};
	const disabled = !!busy || !status || status.run?.state === "running";
	const plan = status?.prepared;
	const reviewed =
		plan && plan.config.repository === value.repository && plan.config.script === value.script;
	return (
		<View style={styles.root}>
			<View style={styles.header}>
				<Action title="Back" onPress={onClose} />
				<Text style={styles.title}>Dotfiles</Text>
			</View>
			<ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
				<View style={styles.column}>
					<Text style={styles.title}>{boxLabel}</Text>
					{!supported ? (
						<>
							<Text style={styles.body}>Update this box to preview and apply dotfiles.</Text>
							<Action
								title={updating ? "Updating…" : "Update box"}
								disabled={updating}
								onPress={onUpdateBox}
							/>
						</>
					) : (
						<>
							<Text style={styles.body}>
								Optional. Bring your shell, tools and agent configuration from a Git repository.
								Preview uses this box's Git access.
							</Text>
							<Text style={styles.label}>Repository URL</Text>
							<TextInput
								accessibilityLabel="Repository URL"
								style={styles.input}
								value={value.repository}
								editable={!disabled}
								onChangeText={(repository) => setValue((v) => ({ ...v, repository }))}
								autoCapitalize="none"
								autoCorrect={false}
								placeholder="https://github.com/you/dotfiles"
								placeholderTextColor={C.faint}
							/>
							<Text style={styles.label}>Install script (optional)</Text>
							<TextInput
								accessibilityLabel="Install script (optional)"
								style={styles.input}
								value={value.script}
								editable={!disabled}
								onChangeText={(script) => setValue((v) => ({ ...v, script }))}
								autoCapitalize="none"
								autoCorrect={false}
								placeholder="Detect automatically, e.g. install.sh"
								placeholderTextColor={C.faint}
							/>
							<Action
								title={busy === "preview" ? "Preparing…" : "Preview"}
								disabled={disabled || !value.repository.trim()}
								onPress={() => void act("preview")}
							/>
							{reviewed ? (
								<View style={styles.panel}>
									<Text selectable style={styles.body}>
										Revision {plan.commit.slice(0, 12)}
									</Text>
									<Text selectable style={styles.body}>
										Checkout: {plan.directory}
									</Text>
									{plan.script ? (
										<>
											<Text style={styles.body}>
												Runs {plan.script} as your engine user, without interactive input. Only
												apply a repository you trust: it can change files and install tools on{" "}
												{boxLabel}.
											</Text>
											<Action
												title={busy === "apply" ? "Starting…" : `Apply to ${boxLabel}`}
												disabled={disabled}
												onPress={() => void act("apply")}
											/>
										</>
									) : (
										<Text style={styles.body}>
											No install script found. Enter a relative executable script path, then preview
											again.
										</Text>
									)}
								</View>
							) : null}
							{status?.run ? (
								<View style={styles.panel}>
									<Text style={styles.label} accessibilityLiveRegion="polite">
										Last apply: {status.run.state} · {status.run.plan.commit.slice(0, 12)}
										{status.run.exitCode !== null ? ` · exit ${status.run.exitCode}` : ""}
									</Text>
									{status.run.state === "running" ? (
										<Text style={styles.body}>
											You can leave this screen. The box stays awake until the installer finishes.
										</Text>
									) : null}
									{status.run.message ? (
										<Text style={styles.body}>{status.run.message}</Text>
									) : null}
									{status.run.log ? (
										<ScrollView style={styles.log}>
											<Text selectable style={styles.logText}>
												{status.run.log.replace(ANSI, "")}
											</Text>
										</ScrollView>
									) : null}
								</View>
							) : null}
							<Text style={styles.body}>
								Saving a default never runs the installer. Desktop engine settings sync may replace
								this box's default.
							</Text>
							<Action
								title={
									busy === "save"
										? "Saving…"
										: value.repository.trim()
											? "Save default on this box"
											: "Clear default on this box"
								}
								disabled={disabled}
								onPress={() => void act("save")}
							/>
							{!status && !error ? <Text style={styles.body}>Loading…</Text> : null}
							{notice ? (
								<Text style={styles.body} accessibilityLiveRegion="polite">
									{notice}
								</Text>
							) : null}
							{error ? (
								<>
									<Text style={styles.error} accessibilityRole="alert">
										{error}
									</Text>
									<Action
										title="Refresh status"
										disabled={!!busy}
										onPress={() => setRefresh((n) => n + 1)}
									/>
								</>
							) : null}
						</>
					)}
				</View>
			</ScrollView>
		</View>
	);
}

function Action({
	title,
	onPress,
	disabled,
}: {
	title: string;
	onPress: () => void;
	disabled?: boolean;
}) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityState={{ disabled: !!disabled }}
			disabled={disabled}
			onPress={onPress}
			style={[styles.button, disabled && styles.disabled]}
		>
			<Text style={styles.buttonText}>{title}</Text>
		</Pressable>
	);
}
const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg, paddingTop: 60 },
	header: {
		flexDirection: "row",
		alignItems: "center",
		gap: 16,
		padding: 16,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
	},
	title: { fontSize: 18, fontWeight: "700", color: C.ink },
	content: { padding: 18, paddingBottom: 48, alignItems: "center" },
	column: { width: "100%", maxWidth: CONTENT_MAX, gap: 12 },
	body: { color: C.muted, fontSize: 14, lineHeight: 21 },
	label: { color: C.ink, fontSize: 14, fontWeight: "600" },
	input: {
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 8,
		padding: 12,
		fontSize: 15,
		color: C.ink,
		backgroundColor: C.surface,
	},
	button: {
		minHeight: 44,
		justifyContent: "center",
		alignSelf: "flex-start",
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 8,
		paddingHorizontal: 14,
		paddingVertical: 10,
	},
	buttonText: { color: C.ink, fontSize: 14, fontWeight: "600" },
	disabled: { opacity: 0.45 },
	panel: { padding: 14, gap: 12, borderWidth: 1, borderColor: C.line, borderRadius: 8 },
	log: { maxHeight: 260, backgroundColor: C.surface, padding: 10 },
	logText: { color: C.ink, fontSize: 12, fontFamily: "monospace" },
	error: { color: C.red, fontSize: 14 },
});
