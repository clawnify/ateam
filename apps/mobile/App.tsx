// Ateam mobile: a thin remote for the boxes running the Ateam engine. The phone
// opens a WebSocket to each saved box's opt-in `ateam` WS listener (over Tailscale),
// handshakes, and drives the SAME engines the desktop does via the shared
// @ateam/protocol contract (see src/connection.ts). Every box is on one LIVE board
// at once, as on the desktop (src/fleet.ts); the composer creates + launches tasks
// on the project's Run on box; tapping a task opens its terminal.
//
// Theme = Ateam's real tokens (apps/desktop/src/renderer/src/index.css): near-black
// #0c0c0e canvas, ink/white for the primary action and every highlight (no accent
// hue), amber/blue/green status. Connection = ALWAYS a WebSocket to a Tailscale address (RN can't spawn
// ssh; WireGuard is the auth boundary).
import type {
	AgentDTO,
	AteamApi,
	BoxSnapshot,
	LeadClient,
	LoopDTO,
	ProjectDTO,
	ProviderDefinition,
	TaskDTO,
} from "@ateam/protocol";
import {
	activeLabel,
	boxSupports,
	buildAteamApi,
	filled,
	type InputValues,
	inputsAt,
	NEEDS_PAIRING,
	PROTOCOL_VERSION,
	providerById,
	unifyProjects,
	WAKE_PROVIDERS,
	type WakeAdapter,
	wakeAdapter,
	withTimeout,
} from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ActionSheetIOS,
	ActivityIndicator,
	Alert,
	AppState,
	KeyboardAvoidingView,
	Linking,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	StatusBar,
	StyleSheet,
	Text,
	TextInput,
	useColorScheme,
	View,
} from "react-native";
import { AgentIcon } from "./src/AgentIcon";
import { filesToBox } from "./src/attach";
import { BoxesScreen } from "./src/BoxesScreen";
import { BoxTerminalScreen } from "./src/BoxTerminalScreen";
import {
	awayOf,
	type BoxLink,
	boxKey,
	boxTitle,
	cantWakeReason,
	leadBoxOf,
	leadFirst,
	NEW_LINK,
	pickRunOn,
	removeBox,
	type SavedBox,
	touchBox,
	withReportedProvider,
} from "./src/boxes";
import { Composer, type ComposerSubmit, type RunOn } from "./src/Composer";
import { ConsentScreen } from "./src/ConsentScreen";
import { connect, mobileNative, redeemPairing } from "./src/connection";
import { pairTarget, parsePairLink } from "./src/pair-link";
import { demoConnection } from "./src/demo";
import { type Board, createFleet, type Fleet, pickProject } from "./src/fleet";
import { GithubAccessScreen } from "./src/GithubAccessScreen";
import { HomeScreen, type ProjectRow, placeText, type TaskPlace } from "./src/HomeScreen";
import { LeadScreen } from "./src/LeadScreen";
import { type LoopDraft, LoopForm, LoopsScreen } from "./src/LoopsScreen";
import type { LeadBadge } from "./src/lead-badge";
import { createLinks, type LinkDeps, type Waker } from "./src/links";
import { MissionScreen } from "./src/MissionScreen";
import { NativeTerminalScreen, ReconnectingTerminal } from "./src/NativeTerminalScreen";
import { ProjectBrowser } from "./src/ProjectBrowser";
import { type ProposalItem, ProposalSheet } from "./src/ProposalSheet";
import { ProviderIcon } from "./src/ProviderIcon";
import { ScanQrIcon } from "./src/ScanQrIcon";
import { useScrollFade } from "./src/scroll-fade";
import {
	loadBoards,
	loadBoxes,
	loadBoxToken,
	loadConsent,
	loadDismissedSkew,
	loadLeadBox,
	loadPreviewPort,
	loadProviderAccount,
	loadRunOn,
	loadSelectedProject,
	removeBoard,
	type SavedConnection,
	saveBoard,
	saveBoxes,
	saveBoxToken,
	saveConsent,
	saveDismissedSkew,
	saveLeadBox,
	savePreviewPort,
	saveProviderAccount,
	saveRunOn,
	saveSelectedProject,
} from "./src/storage";
import { type Tab, TabStrip } from "./src/TabStrip";
import { TerminalScreen } from "./src/TerminalScreen";
import { STATUS_BAR, TopFade } from "./src/TopFade";
import { sortTasks } from "./src/task-order";
import { useLeadBadge } from "./src/useLeadBadge";
import { onReminderTap, syncReminders } from "./src/wait-notifications";
import type { ReminderData } from "./src/wait-reminders";

// SPIKE flag: evaluate the native SwiftTerm terminal (native scroll/select/copy)
// vs the xterm-in-webview one. Flip back to false to fall back to the webview.
const USE_NATIVE_TERMINAL = true;
const Term = USE_NATIVE_TERMINAL ? NativeTerminalScreen : TerminalScreen;

const C = {
	bg: "#0c0c0e",
	surface: "#141418",
	sunken: "#1c1c22",
	line: "#2a2a33",
	ink: "#e6e6ea",
	muted: "#9a9aa6",
	faint: "#6a6a75",
	green: "#4ade80",
	amber: "#fbbf24",
	red: "#f87171",
	blue: "#60a5fa",
};

const TINT: Record<string, string> = {
	[C.amber]: "rgba(251,191,36,0.13)",
	[C.ink]: "rgba(230,230,234,0.12)",
	[C.blue]: "rgba(96,165,250,0.14)",
	[C.green]: "rgba(74,222,128,0.13)",
	[C.muted]: "rgba(154,154,166,0.12)",
	[C.red]: "rgba(248,113,113,0.14)",
};

const COLUMNS: { key: TaskDTO["column"]; label: string; tint: string }[] = [
	{ key: "needs_attention", label: "Needs You", tint: C.amber },
	{ key: "running", label: "In Progress", tint: C.ink },
	{ key: "review", label: "Review", tint: C.blue },
	{ key: "todo", label: "Backlog", tint: C.muted },
	{ key: "merged", label: "Done", tint: C.green },
];

// Cap the phone-first content to a comfortable reading column and center it. A no-op
// on iPhone (wider than any screen), it stops the board/composer/form from stretching
// edge-to-edge on iPad. The terminal is intentionally exempt — more columns is better.
const CONTENT_MAX = 720;

/** How this phone names itself to a box it pairs with. */
const PHONE_LABEL = Platform.OS === "ios" ? "iPhone" : "Phone";

/** A box's key (boxKey) from the `ws://host:port` URL it is dialled at. */
const keyOfUrl = (url: string) => url.replace(/^wss?:\/\//, "").toLowerCase();

function taskNote(t: TaskDTO): string {
	if (t.column === "needs_attention") return "awaiting your input";
	if (t.agentStatus === "running") return "running";
	if (t.mergeStatus) return t.mergeStatus;
	if (t.prNumber != null) return `PR #${t.prNumber}`;
	const dirty = t.gitStatus?.dirty ?? 0;
	if (dirty > 0) return `${dirty} changed`;
	return t.agentStatus ?? "idle";
}

/** Readable task name from the prompt's first words (mirrors the desktop). */
function titleFromPrompt(p: string): string {
	return p.trim().split(/\s+/).slice(0, 6).join(" ").slice(0, 60);
}

function LogoMark() {
	return (
		<View style={styles.logo}>
			<View style={styles.logoTop} />
			<View style={styles.logoBottom}>
				<View style={[styles.logoSq, { opacity: 0.85 }]} />
				<View style={[styles.logoSq, { opacity: 0.6 }]} />
			</View>
		</View>
	);
}

function Badge({ children, tint }: { children: string; tint: string }) {
	return (
		<View style={[styles.badge, { backgroundColor: TINT[tint] ?? C.sunken }]}>
			<Text style={[styles.badgeText, { color: tint }]} numberOfLines={1}>
				{children}
			</Text>
		</View>
	);
}

function AgentTag({ agent }: { agent: string }) {
	const known = agent === "claude" || agent === "codex" || agent === "opencode";
	return (
		<View style={styles.agentTag}>
			{known ? (
				<AgentIcon agentId={agent} size={14} />
			) : (
				<Text style={styles.agentInitial}>{agent[0]?.toUpperCase() ?? "·"}</Text>
			)}
		</View>
	);
}

function TaskCard({
	task,
	tint,
	place,
	onOpen,
}: {
	task: TaskDTO;
	tint: string;
	/** Where it runs (src/HomeScreen.tsx TaskPlace). */
	place: TaskPlace;
	onOpen: () => void;
}) {
	const where = placeText(place);
	return (
		<Pressable style={[styles.card, place.away && styles.cardAway]} onPress={onOpen} hitSlop={2}>
			<View style={styles.cardTop}>
				<AgentTag agent={task.agentId ?? "·"} />
				<Text style={styles.cardName} numberOfLines={2}>
					{task.name}
				</Text>
			</View>
			{/* No branch chip: the branch is the name as a slug. */}
			<View style={styles.cardMeta}>
				<Badge tint={tint}>{taskNote(task)}</Badge>
				{where ? <Badge tint={C.muted}>{where}</Badge> : null}
			</View>
		</Pressable>
	);
}

// ── Connection screen — the box's WebSocket target; back/Disconnect when live ──

function Field({
	label,
	value,
	onChangeText,
	placeholder,
	keyboardType,
	secure,
	last,
}: {
	label: string;
	value: string;
	onChangeText: (t: string) => void;
	placeholder: string;
	keyboardType?: "default" | "numeric";
	secure?: boolean;
	last?: boolean;
}) {
	return (
		<View style={[styles.fieldRow, !last && styles.fieldDivider]}>
			<Text style={styles.fieldLabel}>{label}</Text>
			<TextInput
				style={styles.fieldInput}
				value={value}
				onChangeText={onChangeText}
				placeholder={placeholder}
				placeholderTextColor={C.faint}
				autoCapitalize="none"
				autoCorrect={false}
				keyboardType={keyboardType ?? "default"}
				secureTextEntry={secure}
			/>
		</View>
	);
}

/** The demo's place on the board: a box that isn't one (src/demo.ts). */
const DEMO = "demo";

/** What src/links.ts asks of the app, through a ref the links are made with once. */
type LinkHooks = Pick<
	LinkDeps,
	"askConsent" | "wakerFor" | "lastBoard" | "labelOf" | "save" | "onConnected"
> & { prepare: NonNullable<LinkDeps["prepare"]> };

const NO_HOOKS: LinkHooks = {
	askConsent: () => {},
	wakerFor: async () => null,
	lastBoard: () => null,
	labelOf: (key) => key,
	save: () => {},
	prepare: async () => {},
	onConnected: () => {},
};

// How long one box gets to list a project's tasks before the board goes on without it.
const BOARD_READ_MS = 10_000;

/** A provider's account inputs (its key), from the Keychain. */
function loadAccount(def: ProviderDefinition): Promise<InputValues> {
	return loadProviderAccount(
		def.id,
		inputsAt(def, "account").map((i) => i.key),
	);
}

/** Which of a provider's account inputs have a saved value. */
function savedFlags(def: ProviderDefinition, account: InputValues): Record<string, boolean> {
	return Object.fromEntries(inputsAt(def, "account").map((i) => [i.key, Boolean(account[i.key])]));
}

function ConnectionScreen({
	host,
	port,
	setHost,
	setPort,
	onConnect,
	onBack,
	onBackToList,
	editing,
	onDisconnect,
	onDemo,
	connecting,
	connected,
	error,
	providerId,
	onPickProvider,
	boxValues,
	setBoxValue,
	accountSaved,
	onSaveAccount,
	onRemoveAccount,
	waking,
	notice,
	onScan,
	scanner,
}: {
	/** Add a box by scanning the pairing code a Mac shows (not while editing one). */
	onScan: (() => void) | null;
	/** The scanner, while it is open (App's). */
	scanner: ReactNode;
	host: string;
	port: string;
	setHost: (t: string) => void;
	setPort: (t: string) => void;
	/** The provider this box is woken through, or null for none. */
	providerId: string | null;
	onPickProvider: (id: string | null) => void;
	/** This box's own inputs for that provider (its machine name). */
	boxValues: InputValues;
	setBoxValue: (key: string, value: string) => void;
	/** Which of the provider's account inputs are in the Keychain (never read back). */
	accountSaved: Record<string, boolean>;
	/** Checks the values with the provider, then saves them; resolves whether that worked. */
	onSaveAccount: (def: ProviderDefinition, values: InputValues) => Promise<boolean>;
	onRemoveAccount: (def: ProviderDefinition) => void;
	/** The provider a box is being woken through right now, or null. */
	waking: string | null;
	/** Why the form opened from a tap on a box: what it needs to be woken. */
	notice: string | null;
	onConnect: () => void;
	onBack: () => void;
	/** Back to the Boxes list, when there is one (src/BoxesScreen.tsx). */
	onBackToList: (() => void) | null;
	/** Editing a saved box rather than adding one. */
	editing: boolean;
	onDisconnect: () => void;
	onDemo: () => void;
	connecting: boolean;
	connected: boolean;
	error: string | null;
}) {
	const [picking, setPicking] = useState(false);
	const [drafts, setDrafts] = useState<InputValues>({});
	const def = WAKE_PROVIDERS.find((p) => p.id === providerId) ?? null;
	const boxInputs = def ? inputsAt(def, "box") : [];
	const accountInputs = def ? inputsAt(def, "account") : [];
	const unsaved = accountInputs.filter((i) => !accountSaved[i.key]);
	const keyLabel = accountInputs.length === 1 ? (accountInputs[0]?.label ?? "Key") : "Keys";
	const draftsFilled = unsaved.every((i) => (drafts[i.key] ?? "").trim() !== "");
	const inputRows = [
		...boxInputs.map((input) => ({ input, value: boxValues[input.key] ?? "", draft: false })),
		...unsaved.map((input) => ({ input, value: drafts[input.key] ?? "", draft: true })),
	];
	const options: (ProviderDefinition | null)[] = [null, ...WAKE_PROVIDERS];
	return (
		<View style={styles.root}>
			<StatusBar barStyle="light-content" backgroundColor={C.bg} />
			<View style={styles.navBar}>
				{onBackToList ? (
					<Pressable onPress={onBackToList} hitSlop={8}>
						<Text style={styles.backText}>‹ Boxes</Text>
					</Pressable>
				) : connected ? (
					<Pressable onPress={onBack} hitSlop={8}>
						<Text style={styles.backText}>‹ Board</Text>
					</Pressable>
				) : (
					<LogoMark />
				)}
				{/* The desktop's words for the same thing (EnvironmentPicker.tsx). */}
				<Text style={styles.navTitle} numberOfLines={1}>
					{editing ? "Edit box" : "Add a Tailscale box"}
				</Text>
				<View style={styles.spacer} />
				<Pressable
					style={[styles.connectBtn, connecting && styles.connectBtnBusy]}
					onPress={onConnect}
					disabled={connecting}
					hitSlop={6}
				>
					{connecting ? (
						<ActivityIndicator color="#15151a" size="small" />
					) : (
						<Text style={styles.connectBtnText}>Connect</Text>
					)}
				</Pressable>
			</View>

			<ScrollView contentContainerStyle={styles.formContent} showsVerticalScrollIndicator={false}>
				<View style={styles.contentColumn}>
					{onScan ? (
						<Pressable
							style={[styles.formCard, styles.scanRow]}
							onPress={onScan}
							accessibilityRole="button"
						>
							<ScanQrIcon size={19} color={C.ink} />
							<Text style={styles.scanText}>
								Box locked to your devices? Scan the code from Pair a phone on your Mac.
							</Text>
						</Pressable>
					) : null}
					<View style={styles.eyebrowRow}>
						<View style={[styles.tick, { backgroundColor: C.ink }]} />
						<Text style={styles.eyebrow}>Box</Text>
					</View>
					<View style={styles.formCard}>
						<Field
							label="Tailscale IP or host"
							value={host}
							onChangeText={setHost}
							placeholder="100.x.y.z"
						/>
						<Field
							label="Port"
							value={port}
							onChangeText={setPort}
							placeholder="8787"
							keyboardType="numeric"
						/>
						<Pressable
							style={styles.fieldRow}
							onPress={() => setPicking((p) => !p)}
							hitSlop={4}
							accessibilityRole="button"
							accessibilityLabel={`Provider: ${def?.label ?? "None"}`}
						>
							<Text style={styles.fieldLabel}>Provider</Text>
							<Text style={styles.pickerValue}>{def?.label ?? "None"} ›</Text>
						</Pressable>
					</View>

					{picking ? (
						<View style={[styles.formCard, styles.pickerCard]}>
							{options.map((p, i) => (
								<Pressable
									key={p?.id ?? "none"}
									style={[styles.pickerOption, i < options.length - 1 && styles.fieldDivider]}
									onPress={() => {
										setPicking(false);
										setDrafts({});
										onPickProvider(p?.id ?? null);
									}}
									accessibilityRole="button"
								>
									<ProviderIcon providerId={p?.id} size={30} />
									<View style={styles.pickerText}>
										<Text style={styles.pickerTitle}>{p?.label ?? "None"}</Text>
										<Text style={styles.pickerHint}>
											{p?.wake?.hint ?? "Connect without waking the box"}
										</Text>
									</View>
									{(p?.id ?? null) === (def?.id ?? null) ? (
										<Feather name="check" size={15} color={C.ink} />
									) : null}
								</Pressable>
							))}
						</View>
					) : def && inputRows.length > 0 ? (
						<View style={[styles.formCard, styles.pickerCard]}>
							{inputRows.map(({ input, value, draft }, i) => (
								<Field
									key={input.key}
									label={input.label}
									value={value}
									onChangeText={(t) =>
										draft ? setDrafts((d) => ({ ...d, [input.key]: t })) : setBoxValue(input.key, t)
									}
									placeholder={input.placeholder}
									secure={input.secret}
									last={i === inputRows.length - 1}
								/>
							))}
						</View>
					) : null}
					{!picking && notice ? <Text style={styles.formNotice}>{notice}</Text> : null}
					{!picking && def && accountInputs.length > 0 ? (
						unsaved.length === 0 ? (
							<Pressable
								style={styles.demoBtn}
								onPress={() => onRemoveAccount(def)}
								hitSlop={6}
								accessibilityLabel={`Remove the saved ${def.label} ${keyLabel}`}
							>
								<Text style={styles.demoText}>{keyLabel} saved · Remove</Text>
							</Pressable>
						) : draftsFilled ? (
							<Pressable
								style={styles.demoBtn}
								onPress={() =>
									void onSaveAccount(def, drafts).then((ok) => {
										if (ok) setDrafts({});
									})
								}
								hitSlop={6}
							>
								<Text style={styles.demoText}>Save {keyLabel}</Text>
							</Pressable>
						) : null
					) : null}
					{!picking && def?.wake ? <Text style={styles.formNote}>{def.wake.note}</Text> : null}

					{waking ? <Text style={styles.formNote}>Waking the box through {waking}…</Text> : null}

					{!connected ? (
						<View style={styles.demoRow}>
							<View style={styles.demoRule} />
							<Text style={styles.demoOr}>or</Text>
							<View style={styles.demoRule} />
						</View>
					) : null}
					{!connected ? (
						<Pressable style={styles.demoBtn} onPress={onDemo} hitSlop={6}>
							<Text style={styles.demoText}>Try the demo, no box needed</Text>
						</Pressable>
					) : null}

					{error ? (
						<View style={styles.errorBox}>
							<Text style={styles.errorText}>{error}</Text>
						</View>
					) : null}

					{/* On a phone with no box saved, the demo is all that's connected: this leaves it. */}
					{connected && !onBackToList ? (
						<Pressable style={styles.disconnectBtn} onPress={onDisconnect} hitSlop={6}>
							<Text style={styles.disconnectText}>Disconnect</Text>
						</Pressable>
					) : null}

					<Text style={styles.formNote}>
						The phone opens a WebSocket to your box's `ateam` listener over Tailscale — WireGuard is
						the encryption and the auth boundary. Enable it on the box with{" "}
						<Text style={styles.mono}>ATEAM_WS_ADDR=&lt;tailscale-ip&gt;:&lt;port&gt;</Text>.
					</Text>
				</View>
			</ScrollView>
			{scanner}
		</View>
	);
}

// ── Dev-server preview — open http://<box>:<port> in the phone browser ──
// No tunnel needed: the phone is already on the tailnet, so the box's dev server
// is directly reachable at the same host we connected to. Port is user-set (default
// 3000) and remembered. See issue #73.

function PreviewModal({
	visible,
	host,
	port,
	setPort,
	onOpen,
	onClose,
}: {
	visible: boolean;
	host: string | null;
	port: string;
	setPort: (t: string) => void;
	onOpen: () => void;
	onClose: () => void;
}) {
	return (
		<Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
			<Pressable style={styles.modalBackdrop} onPress={onClose}>
				{/* Inner Pressable swallows taps so touching the card doesn't dismiss it. */}
				<Pressable style={styles.previewCard} onPress={() => {}}>
					<Text style={styles.previewTitle}>Open preview</Text>
					<Text style={styles.previewSub}>
						Opens a dev server running on the box in your browser, over Tailscale.
					</Text>
					<View style={styles.previewUrlRow}>
						<Text style={styles.previewUrlText} numberOfLines={1}>
							http://{host ?? "—"}:
						</Text>
						<TextInput
							style={styles.previewPortInput}
							value={port}
							onChangeText={setPort}
							placeholder="3000"
							placeholderTextColor={C.faint}
							keyboardType="numeric"
							autoFocus
							selectTextOnFocus
						/>
					</View>
					<Pressable
						style={[styles.previewOpenBtn, !host && styles.previewOpenBtnDisabled]}
						onPress={onOpen}
						disabled={!host}
						hitSlop={6}
					>
						<Text style={styles.previewOpenText}>Open in browser</Text>
					</Pressable>
				</Pressable>
			</Pressable>
		</Modal>
	);
}

// The floating top bar's height before it has measured itself (status bar,
// the tabs pill and its padding), so the first frame doesn't jump.
const TOP_INSET_GUESS = STATUS_BAR + 54;

// ── Shell — status dot (left) · tab pill (center) · one of Home / Board / Mission
// Control / Loops below, or the open task's terminal in their place ──

/** A box that runs another Ateam than this app: the banner over the board. */
interface SkewNotice {
	/** The box, named when the phone holds more than one; else null. */
	label: string | null;
	/** Its protocol version. */
	version: number;
	/** An update came back on the same version: the box already runs the newest
	 *  release, and it's this app that is ahead of it. */
	atLatest: boolean;
	updating: boolean;
	/** Why the last update attempt failed. Cleared at the start of the next one. */
	error: string | null;
	onUpdate: () => void;
	/** Hide the banner for this box version (it returns when the version changes). */
	onDismiss: () => void;
}

/** The banner's words for a box on another Ateam than this app. */
function skewText(n: SkewNotice): string {
	const box = n.label ?? "This box";
	if (n.version >= PROTOCOL_VERSION) {
		return `${box} runs a newer Ateam (v${n.version}). Update Ateam Go from the App Store.`;
	}
	return n.atLatest
		? `${box} is on the latest Ateam release (v${n.version}). This app is ahead of it; the next release clears this.`
		: `${box} runs an older Ateam (v${n.version}). It works, but newer features will misbehave.`;
}

/** Where a screen that needs one box stands: the box's own api once it answers,
 *  else what reaching it is doing (the screen waits in place, then remounts). */
interface BoxView {
	/** The box's own api; null while it is being reached. */
	api: AteamApi | null;
	/** Bumps on every connect: keys the screen so it remounts onto the fresh api. */
	gen: number;
	/** What reaching it is doing right now (connect-steps in @ateam/protocol), if anything. */
	status: string | null;
	/** Why the last wake failed, until a wake or a connect succeeds. */
	wakeError: string | null;
}

/** The box terminal: one box's shell, outside every project. */
interface BoxTerminalView extends BoxView {
	title: string;
	onUpdateBox: () => void;
	updating: boolean;
	updateError: string | null;
	boxAtLatest: boolean;
}

function Shell({
	connColor,
	projects,
	selectedKey,
	onSelectProject,
	agents,
	tasks,
	shown,
	placeOf,
	loading,
	creating,
	onOpenConnection,
	onOpenTask,
	onCreate,
	onAddProject,
	notice,
	api,
	tab,
	onTab,
	loops,
	onNewLoop,
	onEditLoop,
	onLoopsChanged,
	openTask,
	openTaskView,
	openTaskFocus,
	onCloseTask,
	onExpandTask,
	boxTerminal,
	onCloseBoxTerminal,
	snack,
	onOpenSnack,
	onDismissSnack,
	composerLead,
	onLeadSent,
	runOn,
	lead,
	leadLabel,
	leadView,
	boxVersion,
	leadOpen,
	onLead,
	leadBadge,
	onUpdateLeadBox,
	updatingLeadBox,
	onStartProposal,
}: {
	connColor: string;
	projects: ProjectRow[];
	selectedKey: string | null;
	onSelectProject: (key: string) => void;
	/** The agents on the box a new task would run on. */
	agents: AgentDTO[];
	/** Every task on every box. */
	tasks: TaskDTO[];
	/** The selected project's tasks, from every box it's on. */
	shown: TaskDTO[];
	/** Where a task runs: its box when it isn't the Lead's, and whether that box is away. */
	placeOf: (task: TaskDTO) => TaskPlace;
	loading: boolean;
	creating: boolean;
	onOpenConnection: () => void;
	onOpenTask: (task: TaskDTO) => void;
	onCreate: (input: ComposerSubmit) => void;
	onAddProject: () => void;
	/** A box that runs another Ateam than this app; null when none does. */
	notice: SkewNotice | null;
	/** The merged board's api (src/fleet.ts): every box at once. */
	api: AteamApi;
	tab: Tab;
	onTab: (tab: Tab) => void;
	/** The selected project's loops. */
	loops: LoopDTO[];
	onNewLoop: () => void;
	onEditLoop: (loop: LoopDTO) => void;
	/** A loop changed from the Loops tab: read the board's loops again. */
	onLoopsChanged: () => void;
	/** The task whose terminal fills the view under the navbar, if any. */
	openTask: TaskDTO | null;
	/** Its box, for the terminal. */
	openTaskView: BoxView;
	/** Whether that terminal should open with the keyboard up (expanded from a tile). */
	openTaskFocus: boolean;
	onCloseTask: () => void;
	/** Expand a Mission Control tile: open its terminal ready to type. */
	onExpandTask: (task: TaskDTO) => void;
	/** The box terminal filling the view under the navbar, if one is open. */
	boxTerminal: BoxTerminalView | null;
	onCloseBoxTerminal: () => void;
	/** Name of the task just started in the background, for the composer's snackbar. */
	snack: string | null;
	onOpenSnack: () => void;
	onDismissSnack: () => void;
	/** The Lead box's Lead for the composer's Task/Lead switch; absent when it has none. */
	composerLead?: LeadClient;
	/** The composer sent a message to the Lead (`open`: show the chat). */
	onLeadSent: (open: boolean) => void;
	/** The composer's Run on, when the project is on more than one box. */
	runOn?: RunOn;
	/** The Lead box's own Lead chat (src/LeadScreen.tsx). */
	lead: LeadClient | null;
	/** The Lead box, named when the phone holds more than one; else null. */
	leadLabel: string | null;
	/** The Lead box while it is being reached; null once it answers. */
	leadView: (BoxView & { title: string }) | null;
	/** The Lead box's protocol version, skewed or not. */
	boxVersion: number;
	/** The Lead chat covers the tabs (the button in the header's right corner). */
	leadOpen: boolean;
	onLead: (open: boolean) => void;
	/** The dot on the Lead button (src/lead-badge.ts). */
	leadBadge: LeadBadge;
	onUpdateLeadBox: () => void;
	updatingLeadBox: boolean;
	/** "Start it" on one of the Lead's proposals. */
	onStartProposal: (item: ProposalItem) => void;
}) {
	// Mission Control tiles: this project's tasks that have (or had) an agent, in
	// Home's order, merged work excluded.
	const missionTasks = sortTasks(
		shown.filter((t) => t.column !== "merged" && t.agentStatus !== null),
		"status",
	);
	// A full terminal (a task's, or a box's) covers the tab's content. The Lead
	// covers it too, under a task opened from one of its chips: closing the task
	// comes back to the chat.
	const covered = openTask !== null || boxTerminal !== null;
	const showLead = leadOpen && !covered;
	const showTab = !covered && !leadOpen;
	// The composer's Task | Lead switch floats over these lists: it fades while
	// one scrolls and returns when it stops.
	const { faded, scrollProps } = useScrollFade();
	// The top bar floats too: these lists scroll beneath it and fade out under
	// it (TopFade), padded by its height so they start below it. Terminals, the
	// Lead and Mission's pages start below it instead.
	const [topInset, setTopInset] = useState(TOP_INSET_GUESS);
	const listUnder = showTab && (tab === "board" || tab === "home" || tab === "loops");
	return (
		<KeyboardAvoidingView
			style={styles.shellRoot}
			behavior={Platform.OS === "ios" ? "padding" : undefined}
		>
			<StatusBar barStyle="light-content" backgroundColor={C.bg} />
			<View style={styles.topBar} onLayout={(e) => setTopInset(e.nativeEvent.layout.height)}>
				{/* Only behind a list: elsewhere the bar has nothing under it to fade. */}
				{listUnder && <TopFade height={topInset} />}
				<View style={styles.boardHeader}>
					<Pressable style={styles.statusHit} onPress={onOpenConnection} hitSlop={10}>
						<View style={[styles.statusDot, { backgroundColor: connColor }]} />
					</Pressable>
					<View style={styles.headerCenter}>
						<TabStrip
							tab={leadOpen ? null : tab}
							onChange={(t) => {
								// A tab tap from the full terminal (or the Lead) leaves it, like the desktop.
								onCloseTask();
								onCloseBoxTerminal();
								onLead(false);
								onTab(t);
							}}
						/>
					</View>
					{/* The Lead, box-wide like the desktop's right sidebar, so it sits apart
				    from the project's tabs. As wide as the status dot's slot, so the tabs
				    stay centered. A box's terminal is on its card in Boxes. */}
					<Pressable
						style={styles.cornerHit}
						onPress={() => {
							// From a task opened out of the chat, back to the chat.
							const back = covered;
							onCloseTask();
							onCloseBoxTerminal();
							onLead(back || !leadOpen);
						}}
						hitSlop={10}
						accessibilityRole="button"
						accessibilityLabel={
							leadBadge === "waiting"
								? "Lead chat, waiting on you"
								: leadBadge === "new"
									? "Lead chat, new messages"
									: "Lead chat"
						}
						accessibilityState={{ selected: showLead }}
					>
						<View>
							<Feather name="message-circle" size={19} color={showLead ? C.ink : C.muted} />
							{leadBadge && (
								<View
									style={[styles.leadDot, leadBadge === "waiting" && { backgroundColor: C.amber }]}
								/>
							)}
						</View>
					</Pressable>
				</View>

				{/* The board still works on a skewed box, so this states the risk and offers
			    the one fix, rather than blocking the way the handshake used to. A box
			    AHEAD of the app can't be fixed from here: updating it would only take it
			    further away, so that case just explains itself. */}
				{notice && (
					<View style={styles.skewBar}>
						<Text style={styles.skewText}>{skewText(notice)}</Text>
						{notice.version < PROTOCOL_VERSION && !notice.atLatest && (
							<Pressable
								style={[styles.skewBtn, notice.updating && styles.skewBtnBusy]}
								onPress={notice.onUpdate}
								disabled={notice.updating}
							>
								<Text style={styles.skewBtnText}>
									{notice.updating ? "Updating…" : "Update box"}
								</Text>
							</Pressable>
						)}
						<Pressable onPress={notice.onDismiss} hitSlop={10} accessibilityLabel="Dismiss">
							<Feather name="x" size={16} color={C.amber} />
						</Pressable>
					</View>
				)}
				{notice?.error && (
					<View style={styles.skewErrorBar}>
						<Text style={styles.skewErrorText}>{notice.error}</Text>
					</View>
				)}
			</View>
			{!listUnder && <View style={{ height: topInset }} />}

			{/* While its box is being reached (asleep, or dropped) an open terminal keeps
			    its place, and attaches (a new gen remounts it) once the box answers. It
			    talks to its box directly: a pasted image must land where its agent is. */}
			{openTask && !openTaskView.api ? (
				<ReconnectingTerminal
					lead={<AgentIcon agentId={openTask.agentId} size={12} />}
					title={(tasks.find((t) => t.id === openTask.id) ?? openTask).name}
					onBack={onCloseTask}
					status={openTaskView.status}
					wakeError={openTaskView.wakeError}
				/>
			) : openTask && openTaskView.api ? (
				<Term
					key={`${openTaskView.gen}:${openTask.id}`}
					api={openTaskView.api}
					task={tasks.find((t) => t.id === openTask.id) ?? openTask}
					onClose={onCloseTask}
					autoFocus={openTaskFocus}
				/>
			) : boxTerminal && !boxTerminal.api ? (
				<ReconnectingTerminal
					lead={<Feather name="terminal" size={12} color={C.ink} />}
					title={boxTerminal.title}
					onBack={onCloseBoxTerminal}
					status={boxTerminal.status}
					wakeError={boxTerminal.wakeError}
				/>
			) : boxTerminal?.api ? (
				<BoxTerminalScreen
					key={`${boxTerminal.gen}:box`}
					api={boxTerminal.api}
					onClose={onCloseBoxTerminal}
					onUpdateBox={boxTerminal.onUpdateBox}
					updating={boxTerminal.updating}
					updateError={boxTerminal.updateError}
					boxAtLatest={boxTerminal.boxAtLatest}
				/>
			) : null}
			{showTab && tab === "board" && (
				<ScrollView
					style={styles.board}
					contentContainerStyle={[styles.boardContent, { paddingTop: topInset + 16 }]}
					showsVerticalScrollIndicator={false}
					keyboardShouldPersistTaps="handled"
					{...scrollProps}
				>
					<View style={styles.contentColumn}>
						{loading && shown.length === 0 ? (
							<View style={styles.centerPad}>
								<ActivityIndicator color={C.ink} />
								<Text style={styles.footnote}>loading board…</Text>
							</View>
						) : shown.length === 0 ? (
							<View style={styles.centerPad}>
								<Text style={styles.footnote}>no tasks yet — start one below</Text>
							</View>
						) : (
							COLUMNS.map((col) => {
								const inCol = shown.filter((t) => t.column === col.key);
								if (inCol.length === 0) return null;
								return (
									<View key={col.key} style={styles.zone}>
										<View style={styles.eyebrowRow}>
											<View style={[styles.tick, { backgroundColor: col.tint }]} />
											<Text style={styles.eyebrow}>{col.label}</Text>
											<Text style={styles.eyebrowCount}>{inCol.length}</Text>
										</View>
										{inCol.map((t) => (
											<TaskCard
												key={t.id}
												task={t}
												tint={col.tint}
												place={placeOf(t)}
												onOpen={() => onOpenTask(t)}
											/>
										))}
									</View>
								);
							})
						)}
					</View>
				</ScrollView>
			)}
			{showTab && tab === "home" && (
				<HomeScreen
					projects={projects}
					selectedKey={selectedKey}
					onSelectProject={onSelectProject}
					placeOf={placeOf}
					onAddProject={onAddProject}
					tasks={shown}
					loops={loops}
					loading={loading}
					onOpenTask={onOpenTask}
					onOpenLoops={() => onTab("loops")}
					onNewLoop={onNewLoop}
					scrollProps={scrollProps}
					topInset={topInset}
				/>
			)}
			{showTab && tab === "mission" && (
				<MissionScreen api={api} tasks={missionTasks} onExpand={onExpandTask} />
			)}
			{showLead && leadView && (
				<ReconnectingTerminal
					lead={<Feather name="message-circle" size={12} color={C.ink} />}
					title={leadView.title}
					onBack={() => onLead(false)}
					status={leadView.status}
					wakeError={leadView.wakeError}
				/>
			)}
			{showLead && !leadView && (
				<LeadScreen
					lead={lead}
					boxLabel={leadLabel}
					supported={boxSupports("lead", boxVersion)}
					boxVersion={boxVersion}
					tasks={tasks}
					onOpenTask={onOpenTask}
					onUpdateBox={onUpdateLeadBox}
					updating={updatingLeadBox}
					onStartProposal={onStartProposal}
				/>
			)}
			{showTab && tab === "loops" && (
				<LoopsScreen
					api={api}
					loops={loops}
					tasks={shown}
					onOpenTask={onOpenTask}
					onCreate={onNewLoop}
					onEdit={onEditLoop}
					onChanged={onLoopsChanged}
					topInset={topInset}
				/>
			)}

			{showTab && (tab === "board" || tab === "home") && (
				<Composer
					agents={agents}
					busy={creating}
					onSubmit={onCreate}
					lead={composerLead}
					onLeadSent={onLeadSent}
					switchFaded={faded}
					snack={snack}
					onOpenSnack={onOpenSnack}
					onDismissSnack={onDismissSnack}
					runOn={runOn}
				/>
			)}
		</KeyboardAvoidingView>
	);
}

export default function App() {
	useColorScheme(); // reserved: theme-aware later
	const [view, setView] = useState<"connect" | "board">("connect");
	// The connection screen shows the Boxes list (src/BoxesScreen.tsx), or the form
	// for adding or editing one. With no saved boxes it is always the form.
	const [connectScreen, setConnectScreen] = useState<"list" | "form">("list");
	const [boxes, setBoxes] = useState<SavedBox[]>([]);
	const boxesRef = useRef<SavedBox[]>([]);
	// The saved box the form is editing, by its key.
	const [editingKey, setEditingKey] = useState<string | null>(null);
	const [swipeOpenKey, setSwipeOpenKey] = useState<string | null>(null);
	// Which of Home / Board / Mission Control / Loops is showing.
	const [tab, setTab] = useState<Tab>("home");
	const [loops, setLoops] = useState<LoopDTO[]>([]);
	// The loop form modal: null closed, `editing` null for a new loop.
	const [loopForm, setLoopForm] = useState<{
		editing: LoopDTO | null;
		/** Opened from one of the Lead's proposals: filled in, and marked created on save. */
		proposal?: { id: string; projectId: string; draft: LoopDraft };
	} | null>(null);
	// A task the Lead proposed, open in its New task sheet.
	const [proposalSheet, setProposalSheet] = useState<ProposalItem | null>(null);
	// The form: the box being added or edited.
	const [host, setHost] = useState("");
	const [port, setPort] = useState("8787");
	// Waking a sleeping box through its provider before connecting (packages/protocol/src/wake.ts).
	// The provider and the box's inputs ride on the saved box; the provider's account
	// inputs (its key) live in the Keychain and are only ever held here, in a ref,
	// never in render state.
	const [providerId, setProviderId] = useState<string | null>(null);
	const [boxValues, setBoxValues] = useState<InputValues>({});
	const [accountSaved, setAccountSaved] = useState<Record<string, boolean>>({});
	const [waking, setWaking] = useState<string | null>(null);
	const [formBusy, setFormBusy] = useState(false);
	// The connection screen's own error: the form's connect, a key that didn't save.
	const [error, setError] = useState<string | null>(null);
	// Why the form opened from a tap on a box (a key or name it needs to be woken).
	const [formNotice, setFormNotice] = useState<string | null>(null);
	const accounts = useRef<Record<string, InputValues>>({});
	// One adapter per provider and key, so its session (boxd's lasts an hour) is reused across connects.
	const wakers = useRef(new Map<string, WakeAdapter>());

	// Every saved box is on the board at once (src/fleet.ts): live, or its last-seen
	// board standing in. Each box's link (reached, kept, retried, woken) is
	// src/links.ts; `links` is where each one stands, for its card and whatever waits
	// on it. The links are made once, so what they ask of the app goes through
	// `hooks`, set again every render below.
	const [fleet] = useState(() => createFleet());
	const board = useMemo(() => buildAteamApi(fleet.rpc, mobileNative), [fleet]);
	const [links, setLinks] = useState<Record<string, BoxLink>>({});
	const hooks = useRef<LinkHooks>(NO_HOOKS);
	const [link] = useState(() =>
		createLinks({
			fleet,
			// With this phone's token for the box, when it is paired with a locked one.
			dial: async (url, onClose) =>
				connect(url, { onClose, token: await loadBoxToken(keyOfUrl(url)) }),
			boxes: () => boxesRef.current,
			consented: () => consented.current,
			askConsent: (then) => hooks.current.askConsent(then),
			wakerFor: (box) => hooks.current.wakerFor(box),
			waitedOn: (key) => waitingOn.current.has(key),
			lastBoard: (key) => hooks.current.lastBoard(key),
			labelOf: (key) => hooks.current.labelOf(key),
			save: (box, replaces) => hooks.current.save(box, replaces),
			prepare: (key, c) => hooks.current.prepare(key, c),
			onConnected: (key, c) => hooks.current.onConnected(key, c),
			onLinks: setLinks,
		}),
	);
	// Each box's board as last seen (src/storage.ts), what stands in while it's away.
	const kept = useRef(new Map<string, BoxSnapshot>());
	// The offline demo stands in for every box while it runs.
	const demo = useRef(false);
	// No board was kept from before (a first launch): the first box that answers
	// takes the app from Boxes to its board, as the one launch connect used to.
	const landOnBoard = useRef(false);

	// A box on another Ateam than this app: the version whose banner was dismissed,
	// per box (it comes back when the box reports a different one), and its update.
	const [skewDismissed, setSkewDismissed] = useState<Record<string, number>>({});
	const [updatingKey, setUpdatingKey] = useState<string | null>(null);
	// Why the last update failed. It renders on the BOARD, where the button lives:
	// a failed update with nowhere to show up just flashed and reverted, which is
	// exactly what an Unknown-method rejection looked like the one time it happened.
	const [updateError, setUpdateError] = useState<{ key: string; message: string } | null>(null);
	// The skew an update started from, per box. If the reconnect lands on the same
	// version, the box already had the newest release: say so instead of offering it again.
	const updateFrom = useRef(new Map<string, number | null>());
	const [atLatest, setAtLatest] = useState<Record<string, boolean>>({});

	const [tasks, setTasks] = useState<TaskDTO[]>([]);
	const [projects, setProjects] = useState<ProjectDTO[]>([]);
	// The selected project as its card key (@ateam/protocol unifyProjects): one repo,
	// on however many boxes.
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [agentsByBox, setAgentsByBox] = useState<Record<string, AgentDTO[]>>({});
	const [loading, setLoading] = useState(false);
	const [creating, setCreating] = useState(false);
	const [openTask, setOpenTask] = useState<TaskDTO | null>(null);
	// A task started from the composer with "stay on board": the snackbar offers
	// the way into it for a few seconds.
	const [startedTask, setStartedTask] = useState<TaskDTO | null>(null);
	useEffect(() => {
		if (!startedTask) return;
		const timer = setTimeout(() => setStartedTask(null), 6000);
		return () => clearTimeout(timer);
	}, [startedTask]);
	// The composer sent its text to the Lead and stayed on the board: the
	// snackbar offers the way into the chat for a few seconds.
	const [leadSent, setLeadSent] = useState(false);
	useEffect(() => {
		if (!leadSent) return;
		const timer = setTimeout(() => setLeadSent(false), 6000);
		return () => clearTimeout(timer);
	}, [leadSent]);
	// A task that couldn't start, said in the snackbar until dismissed or replaced.
	const [failure, setFailure] = useState<string | null>(null);
	const [openTaskFocus, setOpenTaskFocus] = useState(false);
	// What's open over the board that belongs to one box: its terminal, its GitHub
	// access, or adding a project to it. Each holds that box's key.
	const [boxTerminalKey, setBoxTerminalKey] = useState<string | null>(null);
	const [githubKey, setGithubKey] = useState<string | null>(null);
	const [browserKey, setBrowserKey] = useState<string | null>(null);
	const [leadOpen, setLeadOpen] = useState(false);
	// The box whose Lead the phone talks to, as picked in Boxes; and the box a new
	// task runs on when its project is on several (the composer's Run on).
	const [leadPicked, setLeadPicked] = useState<string | null>(null);
	const [runOnPicked, setRunOnPicked] = useState<string | null>(null);
	const [previewOpen, setPreviewOpen] = useState(false);
	const [previewPort, setPreviewPort] = useState("3000");
	// The project to restore on launch (loaded from storage before the first read,
	// so the board opens on it rather than the first one). Updated on every pick.
	const preferredKey = useRef<string | null>(null);
	// The board as it is now, so a box that goes can keep its share of it, and the
	// last full read, for what a connect the user asked for found on its box.
	const boardRef = useRef<Board>({ projects: [], tasks: [], loops: [] });
	boardRef.current = { projects, tasks, loops };
	const lastRead = useRef<Board>({ projects: [], tasks: [], loops: [] });

	const boxByKey = useCallback(
		(key: string): SavedBox | null => boxesRef.current.find((b) => boxKey(b) === key) ?? null,
		[],
	);
	const labelOf = useCallback(
		(key: string): string => {
			if (key === DEMO) return "Demo";
			const box = boxByKey(key);
			return box ? boxTitle(box) : key;
		},
		[boxByKey],
	);

	// A box's share of the board, kept as its last-seen board (src/storage.ts). Not
	// over an earlier one with an empty share: a read that timed out on the box comes
	// back with nothing from it, which is no reason to forget its projects.
	const keepBoard = useCallback(
		(key: string, from: Board): BoxSnapshot | null => {
			if (key === DEMO) return null;
			const snap = fleet.snapshotOf(key, from);
			const before = kept.current.get(key);
			if (snap.projects.length === 0 && before && before.projects.length > 0) return before;
			kept.current.set(key, snap);
			void saveBoard(key, snap);
			return snap;
		},
		[fleet],
	);

	// One read of the whole board, every box at once. A box that stops answering
	// mid-read doesn't hold it up: its projects keep the tasks they showed.
	const readBoard = useCallback(async (): Promise<Board> => {
		const projs = await board.projects.list();
		const before = boardRef.current;
		const perProject = await Promise.all(
			projs.map((p) =>
				withTimeout(board.tasks.list(p.id), BOARD_READ_MS, "tasks").catch(() =>
					before.tasks.filter((t) => t.projectId === p.id),
				),
			),
		);
		const all = perProject.flat().sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0));
		// A box that predates loops rejects the call; the sections just stay empty.
		const boardLoops = await board.loops.list().catch(() => before.loops);
		const read: Board = { projects: projs, tasks: all, loops: boardLoops };
		lastRead.current = read;
		setProjects(projs);
		setTasks(all);
		setLoops(boardLoops);
		const cards = unifyProjects(projs, originsOf(fleet, projs));
		setSelectedKey((cur) => pickProject(cards, cur, preferredKey.current));
		for (const key of fleet.keys()) {
			if (!fleet.isLive(key) || key === DEMO) continue;
			keepBoard(key, read);
			// Each box's whole list, so reminders for waits cleared while away go too.
			const box = boxByKey(key);
			if (box) {
				syncReminders(
					box,
					all.filter((t) => fleet.ownerOf(t.id) === key),
					true,
				);
			}
		}
		return read;
	}, [board, fleet, keepBoard, boxByKey]);

	// Reads are coalesced: one asked for while another runs makes it read once more,
	// and both callers get that newer board. Connects land one per box, close together.
	const refreshing = useRef<Promise<Board> | null>(null);
	const refreshAgain = useRef(false);
	const refresh = useCallback((): Promise<Board> => {
		if (refreshing.current) {
			refreshAgain.current = true;
			return refreshing.current;
		}
		const run = async (): Promise<Board> => {
			setLoading(true);
			try {
				let read: Board;
				do {
					refreshAgain.current = false;
					read = await readBoard();
				} while (refreshAgain.current);
				return read;
			} finally {
				refreshing.current = null;
				setLoading(false);
			}
		};
		refreshing.current = run();
		return refreshing.current;
	}, [readBoard]);

	// A box sends its own loops when they change, not the board's: read them all again.
	const refreshLoops = useCallback(async () => {
		const next = await board.loops.list().catch(() => null);
		if (next) setLoops(next);
	}, [board]);

	// Live updates: merge each pushed task in place (replace by id, or prepend if new).
	// The board's RPC fans in every live box and survives their reconnects (src/fleet.ts).
	useEffect(() => {
		if (view !== "board") return;
		const off = board.events.onTaskUpdated((t) => {
			const owner = fleet.ownerOf(t.id);
			const box = owner ? boxByKey(owner) : null;
			if (box) syncReminders(box, [t], false);
			setTasks((prev) => {
				const i = prev.findIndex((x) => x.id === t.id);
				if (i === -1) return [t, ...prev];
				const next = prev.slice();
				next[i] = t;
				return next;
			});
		});
		const offLoops = board.loops.onUpdated(() => void refreshLoops());
		return () => {
			off();
			offLoops();
		};
	}, [view, board, fleet, boxByKey, refreshLoops]);

	// Consent state. A ref (not state) because connects read it synchronously and must
	// not be re-created when it flips, which would retrigger the effects that depend on it.
	const consented = useRef(false);
	const pendingConnect = useRef<(() => void) | null>(null);
	const [consentOpen, setConsentOpen] = useState(false);

	// The Boxes list as it is now, persisted. Through a ref as well as state, so a
	// connect that lands mid-render still edits the latest list.
	const commitBoxes = useCallback((next: SavedBox[]) => {
		boxesRef.current = next;
		setBoxes(next);
		void saveBoxes(next);
	}, []);

	// How to wake a box through its provider: its key from the Keychain, one adapter
	// per provider and key. src/links.ts asks only when someone wants the box.
	const wakerFor = useCallback(async (box: SavedConnection): Promise<Waker | null> => {
		const def = providerById(box.provider?.id);
		const target = box.provider;
		if (!def || !target) return null;
		let account = accounts.current[def.id];
		if (!account) {
			account = await loadAccount(def);
			accounts.current[def.id] = account;
		}
		if (!filled(def, "box", target.box) || !filled(def, "account", account)) return null;
		const sig = `${def.id}\n${JSON.stringify(account)}`;
		let adapter = wakers.current.get(sig);
		if (!adapter) {
			const fresh = wakeAdapter(def, account);
			if (!fresh) return null;
			adapter = fresh;
			wakers.current.set(sig, fresh);
		}
		const wake = adapter;
		return { label: def.label, ensureAwake: () => wake.ensureAwake(target.box) };
	}, []);

	// Whatever waits on a box right now (its task open, its terminal, the Lead, an
	// update): a box nobody waits on is never woken, so one that sleeps stays asleep.
	const waitingOn = useRef(new Set<string>());

	// What the links ask of the app (src/links.ts), current every render.
	hooks.current = {
		askConsent: (then) => {
			pendingConnect.current = then;
			setConsentOpen(true);
		},
		wakerFor,
		lastBoard: (key) => keepBoard(key, boardRef.current),
		labelOf,
		save: (box, replaces) => commitBoxes(touchBox(boxesRef.current, box, Date.now(), replaces)),
		// Read before the banner can show for a version already dismissed.
		prepare: async (key) => {
			const box = boxByKey(key);
			const dismissed = box ? await loadDismissedSkew(box.host) : null;
			if (dismissed !== null) setSkewDismissed((cur) => ({ ...cur, [key]: dismissed }));
		},
		onConnected: async (key, c) => {
			// A box saved by its address alone takes the provider it says it runs on, so
			// next time it sleeps the phone can wake it rather than time out.
			const withProvider = withReportedProvider(boxesRef.current, key, c.info.provider);
			if (withProvider) commitBoxes(withProvider);
			const nextSkew = c.skewed ? c.info.protocolVersion : null;
			// Only the reconnect that ends an update can say the box is already on the
			// latest release. Any other connect drops the claim: a release may be out since.
			const from = updateFrom.current.get(key);
			const ended = updateFrom.current.delete(key);
			setAtLatest((cur) => ({ ...cur, [key]: ended && nextSkew !== null && nextSkew === from }));
			// Whatever it came back as, it is no longer mid-update: a reconnect is
			// exactly how an update ends, so this is where the spinner stops.
			setUpdatingKey((cur) => (cur === key ? null : cur));
			void c.api.agents.list().then((a) => {
				if (link.conn(key) === c) setAgentsByBox((cur) => ({ ...cur, [key]: a }));
			});
			if (landOnBoard.current) {
				landOnBoard.current = false;
				setView("board");
			}
			await refresh();
		},
	};

	const openOwner = openTask ? fleet.ownerOf(openTask.id) : null;
	const leadKey = demo.current ? DEMO : leadBoxOf(boxes, leadPicked);
	waitingOn.current = new Set(
		[
			openOwner,
			boxTerminalKey,
			githubKey,
			browserKey,
			updatingKey,
			leadOpen ? leadKey : null,
		].filter((k): k is string => k !== null),
	);
	useEffect(() => {
		if (view === "board") link.ensure(openOwner);
	}, [view, openOwner, link]);
	useEffect(() => {
		link.ensure(boxTerminalKey);
	}, [boxTerminalKey, link]);
	useEffect(() => {
		if (leadOpen) link.ensure(leadKey);
	}, [leadOpen, leadKey, link]);

	// Ask a box to replace itself with the current release. The reply lands before
	// the engine goes down, then the socket drops and the reconnect picks it up on
	// the new dist, so success here looks like a disconnect, not a result.
	const updateBox = useCallback(
		async (key: string) => {
			const c = link.conn(key);
			if (!c) return;
			setUpdatingKey(key);
			setUpdateError(null);
			updateFrom.current.set(key, c.skewed ? c.info.protocolVersion : null);
			try {
				await c.update();
			} catch (err) {
				// The likely one: a box older than v7 has no system:update at all, and has
				// to be updated once from a Mac before it can ever do this itself.
				setUpdatingKey(null);
				updateFrom.current.delete(key);
				setUpdateError({ key, message: err instanceof Error ? err.message : String(err) });
			}
		},
		[link],
	);

	// Back to the iOS foreground, the #1 case (app-switching): each box's socket is
	// probed and every box that isn't up tried again (src/links.ts foreground).
	// Going to the background keeps each box's share of the board for next launch.
	useEffect(() => {
		const sub = AppState.addEventListener("change", (s) => {
			if (demo.current) return;
			if (s === "background") {
				for (const key of link.liveKeys()) keepBoard(key, boardRef.current);
				return;
			}
			if (s === "active") link.foreground();
		});
		return () => sub.remove();
	}, [link, keepBoard]);

	// The app itself going (a reload in development): every socket closed, every try stopped.
	useEffect(() => () => link.pause(), [link]);

	// Back from the connection screen to the board.
	const leaveConnect = useCallback(() => {
		setView("board");
		setSwipeOpenKey(null);
	}, []);

	// Fill the form with a saved box, provider and all, or empty it for a new one.
	const fillForm = useCallback(async (box: SavedBox | null) => {
		setHost(box?.host ?? "");
		setPort(box?.port ?? "8787");
		setError(null);
		setFormNotice(null);
		const def = providerById(box?.provider?.id);
		if (!def || !box?.provider) {
			setProviderId(null);
			setBoxValues({});
			setAccountSaved({});
			return;
		}
		const account = accounts.current[def.id] ?? (await loadAccount(def));
		accounts.current[def.id] = account;
		setProviderId(def.id);
		setBoxValues(box.provider.box);
		setAccountSaved(savedFlags(def, account));
	}, []);

	// Leave the demo: the saved boxes come back, their boards as last seen, then
	// their engines.
	const endDemo = useCallback(() => {
		if (!demo.current) return;
		demo.current = false;
		link.forget(DEMO);
		setAgentsByBox({});
		setOpenTask(null);
		setLeadOpen(false);
		for (const b of boxesRef.current) {
			const key = boxKey(b);
			const snap = kept.current.get(key);
			if (snap) fleet.detach(key, { snapshot: snap, label: boxTitle(b) });
		}
		void refresh();
		link.resume();
	}, [fleet, link, refresh]);

	const editBox = useCallback(
		async (box: SavedBox, notice: string | null = null) => {
			landOnBoard.current = false;
			await fillForm(box);
			setFormNotice(notice);
			setEditingKey(boxKey(box));
			setConnectScreen("form");
		},
		[fillForm],
	);

	// A card's tap: back to the board when its box is up; else wake it, then go.
	const openBox = useCallback(
		async (box: SavedBox) => {
			const key = boxKey(box);
			landOnBoard.current = false;
			endDemo();
			if (link.conn(key)) {
				leaveConnect();
				return;
			}
			// A box its provider puts to sleep that this phone can't wake (no key, or no
			// name there): a tap would only dial it asleep and time out, so it opens the
			// box's form at what's missing. Its Connect still reaches a box that's up.
			const why = cantWakeReason(box);
			if (why && !(await wakerFor(box))) {
				await editBox(box, `${why} Add it below.`);
				return;
			}
			if (!(await link.connect(box, { wake: true }))) {
				link.retry(key);
				return;
			}
			leaveConnect();
			// A box with no project has nothing to show, so a wake the user asked for
			// opens Add a project on it.
			if (!lastRead.current.projects.some((p) => fleet.ownerOf(p.id) === key)) setBrowserKey(key);
		},
		[link, endDemo, fleet, leaveConnect, wakerFor, editBox],
	);

	const addBox = useCallback(() => {
		landOnBoard.current = false;
		void fillForm(null);
		setEditingKey(null);
		setConnectScreen("form");
	}, [fillForm]);

	const onPickProvider = useCallback(async (id: string | null) => {
		const def = providerById(id);
		setProviderId(def?.id ?? null);
		setError(null); // an error about the provider just left behind is stale now
		if (!def) {
			setAccountSaved({});
			return;
		}
		const account = accounts.current[def.id] ?? (await loadAccount(def));
		accounts.current[def.id] = account;
		setAccountSaved(savedFlags(def, account));
	}, []);

	const setBoxValue = useCallback(
		(key: string, value: string) => setBoxValues((v) => ({ ...v, [key]: value })),
		[],
	);

	// Saving checks the key with the provider first, one cheap signed-in call, so a
	// key that doesn't work is reported now rather than as a failed wake later.
	const onSaveAccount = useCallback(
		async (def: ProviderDefinition, values: InputValues): Promise<boolean> => {
			const entered = Object.entries(values).map(([key, value]) => [key, value.trim()] as const);
			const account = { ...(accounts.current[def.id] ?? {}), ...Object.fromEntries(entered) };
			try {
				await wakeAdapter(def, account)?.check();
				for (const [key, value] of entered) await saveProviderAccount(def.id, key, value);
				accounts.current[def.id] = account;
				wakers.current.clear();
				setAccountSaved(savedFlags(def, account));
				setError(null);
				setFormNotice(null);
				return true;
			} catch (err) {
				setError(
					`Couldn't save the ${def.label} key: ${err instanceof Error ? err.message : String(err)}`,
				);
				return false;
			}
		},
		[],
	);

	const onRemoveAccount = useCallback(async (def: ProviderDefinition) => {
		try {
			for (const input of inputsAt(def, "account")) {
				await saveProviderAccount(def.id, input.key, null);
			}
			accounts.current[def.id] = {};
			wakers.current.clear();
			setAccountSaved({});
		} catch (err) {
			setError(
				`Couldn't remove the ${def.label} key: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}, []);

	// Take a box off the board: no more tries, its socket closed, its kept board gone.
	const forgetBox = useCallback(
		(key: string) => {
			// Asked before it leaves the board, which stops knowing whose they were.
			const its = new Set(
				boardRef.current.tasks.filter((t) => fleet.ownerOf(t.id) === key).map((t) => t.id),
			);
			link.forget(key);
			setOpenTask((t) => (t && its.has(t.id) ? null : t));
			kept.current.delete(key);
			void removeBoard(key);
			setAgentsByBox(({ [key]: _gone, ...rest }) => rest);
			setBoxTerminalKey((k) => (k === key ? null : k));
			setGithubKey((k) => (k === key ? null : k));
			setBrowserKey((k) => (k === key ? null : k));
			void refresh();
		},
		[fleet, link, refresh],
	);

	const onConnect = useCallback(async () => {
		if (!host.trim()) {
			setError("Enter the box's Tailscale IP or hostname.");
			return;
		}
		const def = providerById(providerId);
		const box: SavedConnection = {
			host: host.trim(),
			port: port.trim() || "8787",
			...(def ? { provider: { id: def.id, box: boxValues } } : {}),
		};
		const key = boxKey(box);
		const replaces = editingKey;
		landOnBoard.current = false;
		endDemo();
		setFormBusy(true);
		setError(null);
		try {
			if (!(await link.connect(box, { wake: true, save: true, replaces, onWaking: setWaking }))) {
				const failed = link.get(key).error;
				// Locked to its paired devices: saved all the same, so its card asks for a code.
				if (failed === NEEDS_PAIRING) {
					commitBoxes(touchBox(boxesRef.current, box, Date.now(), replaces));
					if (replaces && replaces !== key) forgetBox(replaces);
					setEditingKey(null);
					setConnectScreen("list");
					return;
				}
				if (failed) setError(failed);
				return;
			}
			// An edit that moved the box to another address: the old one leaves the board.
			if (replaces && replaces !== key) forgetBox(replaces);
			setEditingKey(null);
			setConnectScreen("list");
			leaveConnect();
			if (!lastRead.current.projects.some((p) => fleet.ownerOf(p.id) === key)) setBrowserKey(key);
		} finally {
			setFormBusy(false);
		}
	}, [
		host,
		port,
		providerId,
		boxValues,
		editingKey,
		link,
		endDemo,
		forgetBox,
		fleet,
		leaveConnect,
		commitBoxes,
	]);

	// Enter demo mode: a fully offline Connection (canned board + terminal) in place
	// of every box, none of them reached meanwhile. For App Review (guideline 2.1)
	// and first-look onboarding.
	const startDemo = useCallback(async () => {
		demo.current = true;
		landOnBoard.current = false;
		link.pause();
		for (const key of fleet.keys()) fleet.remove(key);
		setOpenTask(null);
		setBoxTerminalKey(null);
		setGithubKey(null);
		setBrowserKey(null);
		setLeadOpen(false);
		const d = demoConnection();
		link.adopt(DEMO, d);
		void d.api.agents.list().then((a) => {
			if (link.conn(DEMO) === d) setAgentsByBox({ [DEMO]: a });
		});
		setError(null);
		setView("board");
		setTab("home");
		return refresh();
	}, [fleet, link, refresh]);

	// Accepting resumes whatever was interrupted, so Agree lands you on the board
	// rather than back on a form you already filled in.
	const onAgreeConsent = useCallback(() => {
		consented.current = true;
		setConsentOpen(false);
		void saveConsent();
		const pending = pendingConnect.current;
		pendingConnect.current = null;
		pending?.();
	}, []);

	// Declining is not a dead end: the demo is offline, so it needs no consent at all.
	const onDeclineConsent = useCallback(() => {
		pendingConnect.current = null;
		setConsentOpen(false);
		void startDemo();
	}, [startDemo]);

	// Pick a project and remember it, so the next launch lands on it (not project #1).
	const selectProject = useCallback((key: string) => {
		preferredKey.current = key;
		setSelectedKey(key);
		void saveSelectedProject(key);
	}, []);

	const onLeadBox = useCallback((box: SavedBox) => {
		const key = boxKey(box);
		setLeadPicked(key);
		void saveLeadBox(key);
	}, []);

	// Pairing (protocol v29). A box locked to its paired devices refuses this phone
	// until it trades a one-time code for a token of its own, kept in the Keychain
	// and sent with every connect from then on.
	const pairBox = useCallback(
		async (box: SavedConnection, code: string, save = false) => {
			const key = boxKey(box);
			const token = await redeemPairing(
				`ws://${box.host}:${box.port || "8787"}`,
				code,
				PHONE_LABEL,
			);
			await saveBoxToken(key, token);
			if (!(await link.connect(box, { wake: true, save }))) {
				throw new Error(link.get(key).error ?? "Couldn't connect to the box.");
			}
		},
		[link],
	);
	// Boxes locked from here this session: their open warning goes at once,
	// before the next connect reports them paired.
	const [lockedHere, setLockedHere] = useState<Set<string>>(() => new Set());
	const lockBox = useCallback(
		async (box: SavedBox) => {
			const key = boxKey(box);
			const c = link.conn(key);
			if (!c) throw new Error("Connect to the box first.");
			const grant = await c.lock(PHONE_LABEL);
			await saveBoxToken(key, grant.token);
			setLockedHere((s) => new Set(s).add(key));
		},
		[link],
	);
	// `ateamgo://pair?host=…&port=…&code=…`: the QR a paired Mac shows (Settings →
	// Boxes → Pair a phone), opened by the iPhone's Camera. Any app or web page can
	// open a link like this, so nothing happens on its own: a malformed one is
	// dropped, and a good one asks first, naming the box it would pair with (and
	// save, if it wasn't on the list).
	const offerPairLink = useCallback(
		(url: string | null): void => {
			const link = url ? parsePairLink(url) : null;
			if (!link) return;
			const { box, code } = link;
			Alert.alert(
				"Pair with this box?",
				`Ateam Go pairs with the box at ${box.host}:${box.port}, adding it to your boxes if it isn't there yet. Only go on if you just showed this code on your Mac.`,
				[
					{ text: "Cancel", style: "cancel" },
					{
						text: "Pair",
						onPress: () =>
							void (async () => {
								await booted.current;
								endDemo();
								try {
									// A box already on the list keeps what it was saved with.
									await pairBox(pairTarget(boxesRef.current, link), code, true);
									setView("board");
								} catch (e) {
									setError(e instanceof Error ? e.message : String(e));
									setView("connect");
								}
							})(),
					},
				],
			);
		},
		[pairBox, endDemo],
	);
	useEffect(() => {
		void Linking.getInitialURL().then(offerPairLink);
		const sub = Linking.addEventListener("url", (e) => offerPairLink(e.url));
		return () => sub.remove();
	}, [offerPairLink]);
	// The same link, read by the camera inside the app (src/PairScanner.tsx). Loaded when
	// first opened: a build made before the camera's native code fails on importing it.
	const scannerRef = useRef<typeof import("./src/PairScanner").PairScanner | null>(null);
	const [scanning, setScanning] = useState(false);
	const openScanner = useCallback(() => {
		try {
			scannerRef.current ??= (
				require("./src/PairScanner") as typeof import("./src/PairScanner")
			).PairScanner;
			setScanning(true);
		} catch {
			Alert.alert(
				"No camera in this build",
				"This build of Ateam Go can't scan yet. Type the code instead, or scan it with the iPhone's Camera.",
			);
		}
	}, []);
	const Scanner = scanning ? scannerRef.current : null;
	const scanner = Scanner ? (
		<Scanner
			onClose={() => setScanning(false)}
			onScanned={(url) => {
				setScanning(false);
				offerPairLink(url);
			}}
		/>
	) : null;

	// The projects, one card per repo across boxes (@ateam/protocol unifyProjects).
	const cards = useMemo(
		() => unifyProjects(projects, originsOf(fleet, projects)),
		[projects, fleet],
	);
	// Boxes are named on the board only when there's more than one to tell apart:
	// never in the demo, which stands in for all of them.
	const multi = !demo.current && boxes.length > 1;
	// A project names every box it's on, the Lead's box first: the phone's home, as
	// Local leads the desktop's lists.
	const projectRows: ProjectRow[] = useMemo(
		() =>
			cards.map((c) => ({
				key: c.key,
				name: c.name,
				on: multi
					? leadFirst(
							c.members.map((m) => m.alias ?? ""),
							leadKey,
						)
							.map(labelOf)
							.join(" · ")
					: null,
			})),
		[cards, multi, labelOf, leadKey],
	);
	const selectedCard = cards.find((c) => c.key === selectedKey) ?? null;
	const memberIds = useMemo(
		() => new Set(selectedCard?.members.map((m) => m.projectId) ?? []),
		[selectedCard],
	);
	const shown = useMemo(() => tasks.filter((t) => memberIds.has(t.projectId)), [tasks, memberIds]);
	// Where a task runs, for its row. The Lead's box goes unnamed (the default, as
	// Local is on the desktop: naming it would be noise); a box that sleeps or isn't
	// answering says so, its rows from its board as last seen.
	const placeOf = useCallback(
		(t: TaskDTO): TaskPlace => {
			const key = fleet.ownerOf(t.id);
			if (!key) return { box: null, away: null };
			return {
				box: multi && key !== leadKey ? labelOf(key) : null,
				away: awayOf(links[key]),
			};
		},
		[multi, fleet, labelOf, leadKey, links],
	);
	const isLive = (key: string) => links[key]?.state === "live";
	const runOnKeys = leadFirst(
		(selectedCard?.members ?? []).map((m) => m.alias).filter((k): k is string => k !== null),
		leadKey,
	);
	const runOnKey = pickRunOn(runOnKeys, runOnPicked, leadKey, isLive);
	const runOnMember = selectedCard?.members.find((m) => m.alias === runOnKey) ?? null;
	const runOn: RunOn | undefined =
		runOnKeys.length > 1 && runOnKey
			? {
					options: runOnKeys.map((k) => ({ key: k, label: labelOf(k), live: isLive(k) })),
					value: runOnKey,
					onChange: (k) => {
						setRunOnPicked(k);
						void saveRunOn(k);
					},
				}
			: undefined;

	// Open the box's dev server in the phone browser. The box's IP is the host the
	// phone reaches it at (already on the tailnet): no tunnel, no discovery.
	const openPreview = useCallback(() => {
		const key = runOnKey ?? link.liveKeys()[0] ?? null;
		const h = key ? boxByKey(key)?.host : undefined;
		if (!h) return;
		const p = previewPort.trim() || "3000";
		void savePreviewPort(p);
		setPreviewOpen(false);
		void Linking.openURL(`http://${h}:${p}`);
	}, [previewPort, runOnKey, boxByKey, link]);

	// Settles once the launch read has: a reminder tap that launched the app waits
	// for it rather than racing it to a box.
	const booted = useRef<Promise<void>>(Promise.resolve());
	// On launch: every saved box's board as last seen goes up at once, then each box
	// is reached in the background (holdAll), none of them woken.
	// biome-ignore lint/correctness/useExhaustiveDependencies: one-shot on mount
	useEffect(() => {
		booted.current = (async () => {
			const [savedBoxes, savedProject, savedPreviewPort, agreed, leadBox, runOnBox] =
				await Promise.all([
					loadBoxes(),
					loadSelectedProject(),
					loadPreviewPort(),
					loadConsent(),
					loadLeadBox(),
					loadRunOn(),
				]);
			boxesRef.current = savedBoxes;
			setBoxes(savedBoxes);
			// Read in the same batch as the boxes, so the reach below can't race ahead
			// of it and show the disclosure to someone who already accepted.
			consented.current = agreed;
			preferredKey.current = savedProject;
			if (savedPreviewPort) setPreviewPort(savedPreviewPort);
			setLeadPicked(leadBox);
			setRunOnPicked(runOnBox);
			if (savedBoxes.length === 0) return;
			const boards = await loadBoards(savedBoxes.map(boxKey));
			for (const [key, snap] of boards) kept.current.set(key, snap);
			// A deep link may have opened the demo meanwhile: it has the board until it
			// ends, and ending it puts these boards up and reaches their boxes (endDemo).
			if (demo.current) return;
			for (const b of savedBoxes) {
				const snap = boards.get(boxKey(b));
				if (snap) fleet.detach(boxKey(b), { snapshot: snap, label: boxTitle(b) });
			}
			if (boards.size > 0) {
				setView("board");
				await refresh();
			} else {
				landOnBoard.current = true;
			}
			link.holdAll();
		})();
	}, []);

	// A tapped wait reminder opens its task, waking its box if it sleeps.
	const openReminder = useCallback(
		async (r: ReminderData) => {
			await booted.current;
			const key = boxKey(r);
			const box = boxByKey(key);
			if (!box) return;
			landOnBoard.current = false;
			endDemo();
			if (!link.conn(key) && !(await link.connect(box, { wake: true }))) link.retry(key);
			const read = await refresh();
			const t = read.tasks.find((x) => x.id === r.taskId);
			if (!t) return; // removed since: the board it landed on is the best there is
			setView("board");
			setOpenTaskFocus(false);
			setOpenTask(t);
		},
		[boxByKey, link, endDemo, refresh],
	);
	useEffect(() => onReminderTap((r) => void openReminder(r)), [openReminder]);

	// Deep links, mainly for driving the app to a screen for App Store screenshots
	// (xcrun simctl openurl ateamgo://demo[/task/<id>|/preview]). `ateamgo://demo`
	// enters the offline demo; a trailing /task/<id> opens that task's terminal.
	useEffect(() => {
		const handle = (url: string | null): void => {
			if (!url?.startsWith("ateamgo://demo")) return;
			void (async () => {
				const read = await startDemo();
				const taskId = url.match(/\/task\/([^/?#]+)/)?.[1];
				if (taskId) {
					const t = read.tasks.find((x) => x.id === taskId || x.slug === taskId);
					if (t) setOpenTask(t);
				} else if (url.includes("/preview")) {
					setPreviewOpen(true);
				}
			})();
		};
		void Linking.getInitialURL().then(handle);
		const sub = Linking.addEventListener("url", (e) => handle(e.url));
		return () => sub.remove();
	}, [startDemo]);

	// Leaving the demo from the form, on a phone with no box saved.
	const onLeaveDemo = useCallback(() => {
		endDemo();
		setView("connect");
		setConnectScreen("list");
	}, [endDemo]);

	// Removing a box takes it off the board, as the desktop's does: left on, the next
	// reattach would quietly put it back on the list.
	const onRemoveBox = useCallback(
		(box: SavedBox) => {
			const key = boxKey(box);
			commitBoxes(removeBox(boxesRef.current, key));
			setSwipeOpenKey(null);
			forgetBox(key);
		},
		[commitBoxes, forgetBox],
	);

	// Add a project: to the box it's asked of. With several up, the user picks one;
	// with none up, Boxes is where one is woken.
	const onAddProject = useCallback(() => {
		const up = boxesRef.current.map(boxKey).filter((k) => link.conn(k));
		if (demo.current) return setBrowserKey(DEMO);
		if (up.length === 0) {
			Alert.alert("Add a project", "No box is connected right now. Wake one in Boxes first.", [
				{ text: "Boxes", onPress: () => setView("connect") },
				{ text: "Cancel", style: "cancel" },
			]);
			return;
		}
		if (up.length === 1) return setBrowserKey(up[0] ?? null);
		const labels = up.map(labelOf);
		const pick = (i: number) => {
			const key = up[i];
			if (key) setBrowserKey(key);
		};
		if (Platform.OS === "ios") {
			ActionSheetIOS.showActionSheetWithOptions(
				{
					title: "Add a project to",
					options: [...labels, "Cancel"],
					cancelButtonIndex: labels.length,
				},
				pick,
			);
			return;
		}
		Alert.alert("Add a project to", undefined, [
			...labels.map((text, i) => ({ text, onPress: () => pick(i) })),
			{ text: "Cancel", style: "cancel" as const },
		]);
	}, [labelOf, link]);

	// Composer submit: create a task in the selected project on its Run on box (woken
	// first if it sleeps), launch the agent, and open its terminal (which attaches to
	// the just-spawned session), or, asked to stay, leave the board where it is and
	// say so in the snackbar.
	const onCreate = useCallback(
		async (input: ComposerSubmit) => {
			const member = runOnMember;
			if (!member) return;
			const key = member.alias;
			setCreating(true);
			setFailure(null);
			try {
				if (key && !link.conn(key)) {
					const box = boxByKey(key);
					if (!box || !(await link.connect(box, { wake: true }))) {
						if (box) link.retry(key);
						throw new Error(`Couldn't reach ${labelOf(key)}. Its card in Boxes says why.`);
					}
				}
				// Agent mode supplies an explicit name; normal mode derives it from the prompt.
				const name = input.name?.trim() || titleFromPrompt(input.prompt) || "task";
				const task = await board.tasks.create({
					projectId: member.projectId,
					name,
					agentId: input.agentId,
					// The engine may replace a name nobody typed with a model title, once.
					nameAuto: !input.name?.trim(),
				});
				// Attached on the phone: put on the task's box, where its agent reads them.
				const boxApi = key ? link.conn(key)?.api : undefined;
				const files = input.files.length && boxApi ? await filesToBox(boxApi, input.files) : [];
				await board.pty.spawnAgent({
					taskId: task.id,
					agentId: input.agentId,
					yolo: input.yolo,
					agentMode: input.agentMode,
					prompt: input.prompt || undefined,
					...(files.length ? { files } : {}),
				});
				// Task events from launch already carry newer status and agent data.
				setTasks((prev) => (prev.some((t) => t.id === task.id) ? prev : [task, ...prev]));
				if (input.open) setOpenTask(task);
				else setStartedTask(task);
			} catch (err) {
				setFailure(err instanceof Error ? err.message : String(err));
			} finally {
				setCreating(false);
			}
		},
		[runOnMember, board, boxByKey, link, labelOf],
	);

	// The Lead: the picked box's own Lead (each box runs one, seeing its tasks only).
	const leadConn = leadKey ? (link.conn(leadKey) ?? null) : null;
	const leadVersion = (leadKey ? links[leadKey]?.version : null) ?? PROTOCOL_VERSION;
	const leadClient = leadConn && boxSupports("lead", leadVersion) ? leadConn.lead : null;
	// The dot on the header's Lead button (src/lead-badge.ts): the Lead has something
	// for the user while its chat isn't on screen.
	const leadBadge = useLeadBadge(
		leadClient,
		leadConn ? leadKey : null,
		view === "board" && leadOpen && !openTask && !boxTerminalKey && !browserKey && !githubKey,
	);
	const anyLive = Object.values(links).some((l) => l.state === "live");
	const linkOf = (key: string | null): BoxLink => (key ? links[key] : undefined) ?? NEW_LINK;

	const githubConn = githubKey ? link.conn(githubKey) : undefined;
	if (githubKey && githubConn) {
		return (
			<GithubAccessScreen
				api={githubConn.api}
				boxLabel={labelOf(githubKey)}
				supported={boxSupports("githubAccess", githubConn.info.protocolVersion)}
				onClose={() => setGithubKey(null)}
				onUpdateBox={() => void updateBox(githubKey)}
				updating={updatingKey === githubKey}
			/>
		);
	}

	// The project browser is a full-screen view-swap (NOT a nested modal: presenting
	// a modal while the dropdown modal dismisses deadlocks iOS and freezes the app).
	const browserConn = browserKey ? link.conn(browserKey) : undefined;
	if (browserKey && browserConn) {
		return (
			<ProjectBrowser
				conn={browserConn}
				onClose={() => setBrowserKey(null)}
				onRegistered={(project) => {
					setBrowserKey(null);
					const card = unifyProjects([project], { [project.id]: browserKey })[0];
					if (card) selectProject(card.key);
					void refresh();
				}}
				onOpenTerminal={() => {
					setBrowserKey(null);
					setOpenTask(null);
					setBoxTerminalKey(browserKey);
				}}
				onOpenGithub={() => setGithubKey(browserKey)}
			/>
		);
	}

	if (consentOpen) {
		return <ConsentScreen onAgree={onAgreeConsent} onDemo={onDeclineConsent} />;
	}

	// A board to go back to: the saved boxes' (live, or as last seen), or the demo's.
	const onBoard = demo.current || boxes.length > 0;
	if (view === "connect") {
		if (connectScreen === "list" && boxes.length > 0) {
			return (
				<BoxesScreen
					leading={
						onBoard && !landOnBoard.current ? (
							<Pressable onPress={leaveConnect} hitSlop={8}>
								<Text style={styles.backText}>‹ Board</Text>
							</Pressable>
						) : (
							<LogoMark />
						)
					}
					boxes={boxes}
					links={links}
					leadKey={leadKey}
					onCancel={(box) => link.cancel(boxKey(box))}
					error={error}
					connected={anyLive}
					openKey={swipeOpenKey}
					onSwipeOpen={setSwipeOpenKey}
					onConnect={(box) => void openBox(box)}
					onEdit={(box) => void editBox(box)}
					onSetProvider={(box) =>
						void editBox(box, "Pick the provider this box runs on and enter its name there.")
					}
					onRemove={onRemoveBox}
					onLeadBox={onLeadBox}
					onAdd={addBox}
					onDemo={() => void startDemo()}
					onBoxTerminal={(box) => {
						setView("board");
						setOpenTask(null);
						setBoxTerminalKey(boxKey(box));
					}}
					onGithub={(box) => setGithubKey(boxKey(box))}
					openKeys={
						new Set(
							boxes
								.map(boxKey)
								.filter(
									(k) =>
										links[k]?.state === "live" &&
										link.conn(k)?.pairing?.state === "open" &&
										!lockedHere.has(k),
								),
						)
					}
					onPair={(box, code) => pairBox(box, code)}
					onLock={lockBox}
					onScan={openScanner}
					scanner={scanner}
				/>
			);
		}
		return (
			<ConnectionScreen
				host={host}
				port={port}
				setHost={setHost}
				setPort={setPort}
				onConnect={() => void onConnect()}
				onBack={leaveConnect}
				onBackToList={
					boxes.length > 0
						? () => {
								setEditingKey(null);
								setError(null);
								setConnectScreen("list");
							}
						: null
				}
				editing={editingKey !== null}
				onDisconnect={onLeaveDemo}
				onDemo={() => void startDemo()}
				connecting={formBusy}
				connected={anyLive}
				error={error}
				providerId={providerId}
				onPickProvider={(id) => void onPickProvider(id)}
				boxValues={boxValues}
				setBoxValue={setBoxValue}
				accountSaved={accountSaved}
				onSaveAccount={onSaveAccount}
				onRemoveAccount={(def) => void onRemoveAccount(def)}
				waking={waking}
				notice={formNotice}
				onScan={editingKey === null ? openScanner : null}
				scanner={scanner}
			/>
		);
	}

	// The first live box on another Ateam than this app, whose banner isn't dismissed.
	const skewKey =
		[...boxes.map(boxKey), ...(demo.current ? [DEMO] : [])].find((k) => {
			const l = links[k];
			return (
				l?.state === "live" &&
				l.version !== null &&
				l.version !== PROTOCOL_VERSION &&
				skewDismissed[k] !== l.version
			);
		}) ?? null;
	const skewVersion = skewKey ? links[skewKey]?.version : null;
	const notice =
		skewKey && skewVersion != null
			? {
					label: multi ? labelOf(skewKey) : null,
					version: skewVersion,
					atLatest: atLatest[skewKey] ?? false,
					updating: updatingKey === skewKey,
					error: updateError?.key === skewKey ? updateError.message : null,
					onUpdate: () => void updateBox(skewKey),
					onDismiss: () => {
						setSkewDismissed((cur) => ({ ...cur, [skewKey]: skewVersion }));
						void saveDismissedSkew(boxByKey(skewKey)?.host ?? "", skewVersion);
					},
				}
			: null;

	const openLink = linkOf(openOwner);
	const termLink = linkOf(boxTerminalKey);
	const leadLink = linkOf(leadKey);
	return (
		<>
			<Shell
				connColor={anyLive ? C.green : C.faint}
				projects={projectRows}
				selectedKey={selectedKey}
				onSelectProject={selectProject}
				agents={(runOnKey ? agentsByBox[runOnKey] : undefined) ?? []}
				tasks={tasks}
				shown={shown}
				placeOf={placeOf}
				loading={loading}
				creating={creating}
				snack={
					startedTask ? `Started ${startedTask.name}` : leadSent ? "Sent to the Lead" : failure
				}
				onOpenSnack={() => {
					// The list copy has the launch's newer status, if it has arrived.
					if (startedTask) setOpenTask(tasks.find((t) => t.id === startedTask.id) ?? startedTask);
					else if (leadSent) setLeadOpen(true);
					setStartedTask(null);
					setLeadSent(false);
					setFailure(null);
				}}
				onDismissSnack={() => {
					setStartedTask(null);
					setLeadSent(false);
					setFailure(null);
				}}
				composerLead={leadClient ?? undefined}
				onLeadSent={(open) => {
					if (!open) return setLeadSent(true);
					// The chat streams the answer; it covers the tabs, so close what covers it.
					setOpenTask(null);
					setBoxTerminalKey(null);
					setLeadOpen(true);
				}}
				runOn={runOn}
				onOpenConnection={() => {
					setView("connect");
					setConnectScreen("list");
				}}
				onOpenTask={setOpenTask}
				onCreate={(input) => void onCreate(input)}
				onAddProject={onAddProject}
				notice={notice}
				api={board}
				tab={tab}
				onTab={setTab}
				loops={loops.filter((l) => l.projectId !== null && memberIds.has(l.projectId))}
				onNewLoop={() => setLoopForm({ editing: null })}
				onEditLoop={(l) => setLoopForm({ editing: l })}
				onLoopsChanged={() => void refreshLoops()}
				openTask={openTask}
				openTaskView={{
					// A task no read has placed yet goes through the board, which routes it.
					api: openOwner ? (link.conn(openOwner)?.api ?? null) : board,
					gen: openLink.gen,
					status: activeLabel(openLink.steps),
					wakeError: openLink.wakeError,
				}}
				openTaskFocus={openTaskFocus}
				onCloseTask={() => {
					setOpenTask(null);
					setOpenTaskFocus(false);
				}}
				onExpandTask={(t) => {
					setOpenTaskFocus(true);
					setOpenTask(t);
				}}
				boxTerminal={
					boxTerminalKey
						? {
								title: multi ? `${labelOf(boxTerminalKey)} terminal` : "Box terminal",
								api: link.conn(boxTerminalKey)?.api ?? null,
								gen: termLink.gen,
								status: activeLabel(termLink.steps),
								wakeError: termLink.wakeError,
								onUpdateBox: () => void updateBox(boxTerminalKey),
								updating: updatingKey === boxTerminalKey,
								updateError: updateError?.key === boxTerminalKey ? updateError.message : null,
								boxAtLatest: atLatest[boxTerminalKey] ?? false,
							}
						: null
				}
				onCloseBoxTerminal={() => setBoxTerminalKey(null)}
				lead={leadClient}
				leadLabel={multi && leadKey ? labelOf(leadKey) : null}
				leadView={
					leadOpen && leadKey && !leadConn
						? {
								title: multi ? `Lead on ${labelOf(leadKey)}` : "Lead",
								api: null,
								gen: leadLink.gen,
								status: activeLabel(leadLink.steps),
								wakeError: leadLink.wakeError,
							}
						: null
				}
				boxVersion={leadVersion}
				leadOpen={leadOpen}
				onLead={setLeadOpen}
				leadBadge={leadBadge}
				onUpdateLeadBox={() => {
					if (leadKey) void updateBox(leadKey);
				}}
				updatingLeadBox={leadKey !== null && updatingKey === leadKey}
				onStartProposal={(item) => {
					if (item.proposal.kind === "task") return setProposalSheet(item);
					const p = item.proposal;
					setLoopForm({
						editing: null,
						proposal: {
							id: item.id,
							projectId: item.projectId,
							draft: {
								name: p.name,
								prompt: p.prompt,
								agentId: p.agentId,
								followUp: p.followUp,
								everyMinutes: p.everyMinutes,
								dailyAt: p.dailyAt,
								yolo: p.yolo,
							},
						},
					});
				}}
			/>
			{proposalSheet && leadConn && (
				<ProposalSheet
					item={proposalSheet}
					agents={(leadKey ? agentsByBox[leadKey] : undefined) ?? []}
					onClose={() => setProposalSheet(null)}
					onStart={async (input) => {
						const c = leadConn;
						// The proposal is the Lead box's, and so is its project: the board routes there.
						const task = await board.tasks.create({
							projectId: input.projectId,
							name: input.name,
							agentId: input.agentId,
						});
						await board.pty.spawnAgent({
							taskId: task.id,
							agentId: input.agentId,
							yolo: input.yolo,
							prompt: input.prompt,
							...(input.files.length ? { files: input.files } : {}),
						});
						void c.lead.proposalCreated(proposalSheet.id, task.id).catch(() => {});
						setTasks((prev) => (prev.some((t) => t.id === task.id) ? prev : [task, ...prev]));
						setProposalSheet(null);
						const card = cards.find((k) => k.members.some((m) => m.projectId === input.projectId));
						if (card) selectProject(card.key);
						// The task's terminal covers the chat; closing it comes back to the Lead.
						setOpenTask(task);
					}}
				/>
			)}
			{loopForm && (
				<LoopForm
					api={board}
					agents={(runOnKey ? agentsByBox[runOnKey] : undefined) ?? []}
					projectId={loopForm.proposal?.projectId ?? runOnMember?.projectId ?? null}
					boxProtocol={
						linkOf(
							loopForm.proposal
								? leadKey
								: loopForm.editing
									? fleet.ownerOf(loopForm.editing.id)
									: runOnKey,
						).version ?? PROTOCOL_VERSION
					}
					editing={loopForm.editing}
					draft={loopForm.proposal?.draft}
					onClose={() => setLoopForm(null)}
					onSaved={() => {
						const from = loopForm.proposal;
						if (from) void leadConn?.lead.proposalCreated(from.id).catch(() => {});
						setLoopForm(null);
						void refreshLoops();
					}}
				/>
			)}
			<PreviewModal
				visible={previewOpen}
				host={(() => {
					const key = runOnKey ?? link.liveKeys()[0] ?? null;
					return key ? (boxByKey(key)?.host ?? null) : null;
				})()}
				port={previewPort}
				setPort={setPreviewPort}
				onOpen={openPreview}
				onClose={() => setPreviewOpen(false)}
			/>
		</>
	);
}

/** Which box owns each project, as the board's reads taught it (src/fleet.ts). */
function originsOf(fleet: Fleet, projects: ProjectDTO[]): Record<string, string | null> {
	return Object.fromEntries(projects.map((p) => [p.id, fleet.ownerOf(p.id)]));
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg, paddingTop: 60 },
	// The board's shell: no top padding, the floating top bar holds the status bar's.
	shellRoot: { flex: 1, backgroundColor: C.bg },
	topBar: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 10, paddingTop: STATUS_BAR },

	// logo mark (icon.svg redrawn) — connection screen only
	logo: {
		width: 32,
		height: 32,
		borderRadius: 9,
		backgroundColor: "#26262e",
		borderWidth: 1,
		borderColor: C.line,
		paddingHorizontal: 6,
		paddingVertical: 6,
		justifyContent: "center",
		gap: 2.5,
	},
	logoTop: { height: 9, borderRadius: 1.5, backgroundColor: C.ink },
	logoBottom: { flexDirection: "row", gap: 2.5 },
	logoSq: { flex: 1, height: 8, borderRadius: 1.5, backgroundColor: "#ffffff" },

	// board header: [status dot] [project dropdown centered] [spacer]
	boardHeader: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 14,
		paddingBottom: 12,
	},
	statusHit: { width: 44, alignItems: "flex-start", justifyContent: "center" },
	statusDot: { width: 12, height: 12, borderRadius: 6 },
	headerCenter: { flex: 1, alignItems: "center" },
	cornerHit: { width: 44, alignItems: "flex-end", justifyContent: "center" },
	// On the bubble's top-right shoulder, ringed in the header's colour so it
	// reads apart from the outline.
	leadDot: {
		position: "absolute",
		top: -2,
		right: -3,
		width: 9,
		height: 9,
		borderRadius: 5,
		backgroundColor: C.ink,
		borderWidth: 2,
		borderColor: C.bg,
	},
	projPill: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
		paddingHorizontal: 14,
		paddingVertical: 7,
		borderRadius: 999,
		maxWidth: 240,
	},
	projName: { color: C.ink, fontSize: 14, fontWeight: "700", letterSpacing: -0.2 },

	// project dropdown modal
	modalBackdrop: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.5)",
		paddingTop: 100,
		alignItems: "center",
	},

	// dev-server preview modal
	previewCard: {
		width: 300,
		backgroundColor: C.surface,
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 12,
		padding: 16,
	},
	previewTitle: { color: C.ink, fontSize: 16, fontWeight: "700", letterSpacing: -0.2 },
	previewSub: { color: C.muted, fontSize: 12, lineHeight: 17, marginTop: 6 },
	previewUrlRow: {
		flexDirection: "row",
		alignItems: "center",
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 8,
		paddingHorizontal: 12,
		paddingVertical: 4,
		marginTop: 14,
	},
	previewUrlText: { color: C.muted, fontSize: 13, fontVariant: ["tabular-nums"], flexShrink: 1 },
	previewPortInput: {
		color: C.ink,
		fontSize: 13,
		fontVariant: ["tabular-nums"],
		fontWeight: "700",
		paddingVertical: 8,
		minWidth: 56,
	},
	previewOpenBtn: {
		backgroundColor: C.ink,
		borderRadius: 8,
		paddingVertical: 11,
		alignItems: "center",
		marginTop: 14,
	},
	previewOpenBtnDisabled: { opacity: 0.4 },
	previewOpenText: { color: "#15151a", fontSize: 14, fontWeight: "800" },

	// connection nav
	navBar: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingHorizontal: 18,
		paddingBottom: 14,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
	},
	navTitle: { color: C.ink, fontSize: 17, fontWeight: "700", letterSpacing: -0.2 },
	backText: { color: C.ink, fontSize: 15, fontWeight: "600" },
	spacer: { flex: 1 },
	connectBtn: {
		backgroundColor: C.ink,
		paddingHorizontal: 16,
		paddingVertical: 8,
		borderRadius: 8,
		minWidth: 84,
		alignItems: "center",
	},
	connectBtnBusy: { opacity: 0.7 },
	connectBtnText: { color: "#15151a", fontSize: 13, fontWeight: "800" },

	// eyebrow
	eyebrowRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginBottom: 10,
		paddingLeft: 2,
	},
	tick: { width: 3, height: 12, borderRadius: 2 },
	eyebrow: {
		color: C.muted,
		fontSize: 11,
		fontWeight: "600",
		textTransform: "uppercase",
		letterSpacing: 1.1,
	},
	eyebrowCount: { color: C.faint, fontSize: 11, fontWeight: "600", fontVariant: ["tabular-nums"] },

	// connection form
	formContent: { padding: 16, paddingTop: 20, paddingBottom: 40 },
	formCard: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 10 },
	scanRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingHorizontal: 14,
		paddingVertical: 12,
		marginBottom: 18,
	},
	scanText: { flex: 1, color: C.ink, fontSize: 14, lineHeight: 20 },
	fieldRow: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 14,
		paddingVertical: 6,
		gap: 12,
	},
	fieldDivider: { borderBottomWidth: 1, borderBottomColor: C.line },
	fieldLabel: { color: C.muted, fontSize: 14 },
	fieldInput: {
		color: C.ink,
		fontSize: 14,
		fontVariant: ["tabular-nums"],
		flex: 1,
		textAlign: "right",
		paddingVertical: 8,
	},
	errorBox: {
		backgroundColor: TINT[C.red],
		borderWidth: 1,
		borderColor: "rgba(248,113,113,0.4)",
		borderRadius: 8,
		padding: 12,
		marginTop: 16,
	},
	errorText: { color: C.red, fontSize: 13, lineHeight: 18 },
	disconnectBtn: {
		marginTop: 20,
		borderWidth: 1,
		borderColor: "rgba(248,113,113,0.4)",
		borderRadius: 10,
		paddingVertical: 12,
		alignItems: "center",
	},
	disconnectText: { color: C.red, fontSize: 14, fontWeight: "700" },
	demoRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 20 },
	demoRule: { flex: 1, height: 1, backgroundColor: C.line },
	demoOr: { color: C.faint, fontSize: 12 },
	demoBtn: {
		marginTop: 14,
		borderWidth: 1,
		borderColor: C.line,
		backgroundColor: C.surface,
		borderRadius: 10,
		paddingVertical: 13,
		alignItems: "center",
	},
	demoText: { color: C.ink, fontSize: 14, fontWeight: "700" },
	formNote: { color: C.faint, fontSize: 12, lineHeight: 18, marginTop: 18, paddingHorizontal: 2 },
	formNotice: { color: C.ink, fontSize: 13, lineHeight: 19, marginTop: 12, paddingHorizontal: 2 },
	pickerValue: { color: C.ink, fontSize: 14, paddingVertical: 8 },
	pickerCard: { marginTop: 8 },
	pickerOption: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 14,
		paddingVertical: 10,
		gap: 12,
	},
	pickerText: { flex: 1, gap: 2 },
	pickerTitle: { color: C.ink, fontSize: 14 },
	pickerHint: { color: C.faint, fontSize: 12 },
	mono: { color: C.muted, fontVariant: ["tabular-nums"] },

	// board
	// Warns without alarming: the board underneath still works.
	skewBar: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingHorizontal: 14,
		paddingVertical: 9,
		backgroundColor: "#3a2f12",
		borderBottomWidth: 1,
		borderBottomColor: "#5a4a1c",
	},
	skewText: { flex: 1, color: "#f0d68c", fontSize: 12, lineHeight: 16 },
	skewBtn: {
		paddingHorizontal: 11,
		paddingVertical: 6,
		borderRadius: 6,
		backgroundColor: "#5a4a1c",
	},
	skewBtnBusy: { opacity: 0.55 },
	skewBtnText: { color: "#ffe9ad", fontSize: 12, fontWeight: "600" },
	// A failed update, directly under the row whose button caused it. Red rather
	// than the banner's amber: this is the one case that's a genuine failure, not
	// a known, working-as-intended state.
	skewErrorBar: {
		paddingHorizontal: 14,
		paddingVertical: 8,
		backgroundColor: "#3a1414",
		borderBottomWidth: 1,
		borderBottomColor: "#5a2020",
	},
	skewErrorText: { color: "#f8a8a8", fontSize: 12, lineHeight: 16 },
	board: { flex: 1 },
	boardContent: { padding: 16, paddingBottom: 24 },
	// Centered, width-capped content column (see CONTENT_MAX) — keeps the phone layout
	// from stretching on iPad; a no-op on iPhone.
	contentColumn: { width: "100%", maxWidth: CONTENT_MAX, alignSelf: "center" },
	centerPad: { alignItems: "center", paddingVertical: 48, gap: 12 },
	zone: { marginBottom: 22 },
	card: {
		backgroundColor: C.surface,
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 8,
		padding: 12,
		marginBottom: 8,
	},
	// From a box that's asleep or not answering: its board as last seen.
	cardAway: { opacity: 0.55 },
	cardTop: { flexDirection: "row", alignItems: "flex-start", gap: 9 },
	agentTag: {
		width: 22,
		height: 22,
		borderRadius: 6,
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
		alignItems: "center",
		justifyContent: "center",
	},
	agentInitial: { color: C.muted, fontSize: 11, fontWeight: "700" },
	cardName: { color: C.ink, fontSize: 15, fontWeight: "600", flex: 1, lineHeight: 20 },
	cardMeta: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10, flexWrap: "wrap" },
	badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
	badgeText: { fontSize: 11, fontWeight: "600" },
	footnote: { color: C.faint, fontSize: 11, textAlign: "center", marginTop: 8 },
});
