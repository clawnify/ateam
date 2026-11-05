// Every box the phone has saved, as cards (src/boxes.ts keeps the list). The phone
// holds all of them at once, as one board (src/fleet.ts), so a card says where its
// box stands: connected, being reached, asleep, or why the last attempt failed. Tap
// one that isn't connected to wake it; swipe left to edit it, remove it from the
// list, or make it the box whose Lead the phone talks to; + to add a Tailscale box.
// The form itself stays in App.tsx. The words match the desktop's Run on list
// (EnvironmentPicker.tsx): a box, Add a Tailscale box, Remove from this list.
//
// The phone dials every box over the tailnet, which leaves a sleeping one asleep;
// only a tap (or opening something on it) wakes one through its provider. While a
// box is being reached, a tray under its card lists the steps (@ateam/protocol
// connect-steps): a woken box can take minutes to answer, and a bare spinner for
// that long reads as stuck.

import { type ConnectStep, NEEDS_PAIRING } from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	Animated,
	PanResponder,
	Pressable,
	ScrollView,
	StatusBar,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import {
	type BoxLink,
	boxKey,
	boxSubtitle,
	boxTitle,
	NEW_LINK,
	NO_PROVIDER_HINT,
	needsProvider,
	type SavedBox,
} from "./boxes";
import { ProviderIcon } from "./ProviderIcon";
import { ScanQrIcon } from "./ScanQrIcon";
import { C, CONTENT_MAX } from "./theme";

/** How far a card slides open, per action behind it (Edit, Remove, and Lead). */
const ACTION_WIDTH = 80;

export function BoxesScreen({
	leading,
	boxes,
	links,
	leadKey,
	onCancel,
	error,
	connected,
	openKey,
	onSwipeOpen,
	onConnect,
	onEdit,
	onSetProvider,
	onRemove,
	onLeadBox,
	onAdd,
	onDemo,
	onBoxTerminal,
	onGithub,
	openKeys,
	onPair,
	onLock,
	onScan,
	scanner,
	settingUp,
}: {
	/** The nav bar's left slot: back to the board when there is one, else the logo. */
	leading: ReactNode;
	/** A box being created on Hetzner from this phone: its card says so while Ateam
	 *  installs itself on it, rather than that it can't be reached, and opens Create a box. */
	settingUp: { key: string; onOpen: () => void } | null;
	boxes: SavedBox[];
	/** Where the link to each box stands, by its key. */
	links: Record<string, BoxLink>;
	/** The box whose Lead the phone talks to. */
	leadKey: string | null;
	/** Stop waiting for a woken box. */
	onCancel: (box: SavedBox) => void;
	/** What went wrong outside any one box (a key that didn't save). */
	error: string | null;
	/** Some box is connected: the demo is offered only when none is. */
	connected: boolean;
	/** The card swiped open, if any: one at a time. */
	openKey: string | null;
	onSwipeOpen: (key: string | null) => void;
	/** A card's tap: back to the board when its box is connected, else wake it. */
	onConnect: (box: SavedBox) => void;
	onEdit: (box: SavedBox) => void;
	/** Open the box's form at its provider: it isn't answering, and the phone can't
	 *  wake it without one (boxes.ts needsProvider). */
	onSetProvider: (box: SavedBox) => void;
	onRemove: (box: SavedBox) => void;
	/** Make this the box whose Lead the phone talks to. */
	onLeadBox: (box: SavedBox) => void;
	onAdd: () => void;
	onDemo: () => void;
	/** Open a connected box's own terminal (outside every project). */
	onBoxTerminal: (box: SavedBox) => void;
	/** Open a connected box's GitHub access (sign-in, token, which repos it can push to). */
	onGithub: (box: SavedBox) => void;
	/** Connected boxes that can be locked and aren't: anyone on the network may use them. */
	openKeys: Set<string>;
	/** Pair this phone with a locked box using a one-time code. */
	onPair: (box: SavedBox, code: string) => Promise<void>;
	/** Lock an open box to the devices paired with it, starting with this phone. */
	onLock: (box: SavedBox) => Promise<void>;
	/** Scan the pairing code a Mac shows: pairs the box it names, adding it if new. */
	onScan: () => void;
	/** The scanner, while it is open (App's). */
	scanner: ReactNode;
}) {
	// With one box there's nothing to choose: its Lead is the Lead.
	const choosingLead = boxes.length > 1;
	return (
		<View style={styles.root}>
			<StatusBar barStyle="light-content" backgroundColor={C.bg} />
			<View style={styles.navBar}>
				{leading}
				<Text style={styles.navTitle}>Boxes</Text>
				<View style={styles.spacer} />
				<Pressable
					style={styles.addBtn}
					onPress={onScan}
					hitSlop={8}
					accessibilityRole="button"
					accessibilityLabel="Scan a pairing code from your Mac"
				>
					<ScanQrIcon size={18} color={C.ink} />
				</Pressable>
				<Pressable
					style={styles.addBtn}
					onPress={onAdd}
					hitSlop={8}
					accessibilityRole="button"
					accessibilityLabel="Add a Tailscale box"
				>
					<Feather name="plus" size={18} color={C.ink} />
				</Pressable>
			</View>

			<ScrollView
				contentContainerStyle={styles.content}
				showsVerticalScrollIndicator={false}
				// Scrolling the list closes an open card, like iOS Mail.
				onScrollBeginDrag={() => onSwipeOpen(null)}
			>
				<View style={styles.column}>
					{boxes.map((box) => {
						const key = boxKey(box);
						const link = links[key] ?? NEW_LINK;
						const live = link.state === "live";
						const isLead = choosingLead && key === leadKey;
						const making = settingUp?.key === key && !live ? settingUp : null;
						return (
							<BoxCard
								key={key}
								box={box}
								live={live}
								reaching={link.state === "connecting"}
								asked={link.asked}
								asleep={link.state === "down" && link.asleep}
								failure={link.state === "down" && !link.asleep && !making ? link.error : null}
								note={making ? "Setting itself up on Hetzner, about 4 minutes" : null}
								// A try in the background shows only as the spinner; the steps are for one asked for.
								steps={link.asked ? link.steps : []}
								lead={isLead}
								onCancel={() => onCancel(box)}
								open={key === openKey}
								onOpenChange={(open) => onSwipeOpen(open ? key : null)}
								onPress={() => (making ? making.onOpen() : onConnect(box))}
								onEdit={() => onEdit(box)}
								onSetProvider={needsProvider(box, link) ? () => onSetProvider(box) : undefined}
								onRemove={() => onRemove(box)}
								onLead={choosingLead && !isLead ? () => onLeadBox(box) : undefined}
								onTerminal={live ? () => onBoxTerminal(box) : undefined}
								onGithub={live ? () => onGithub(box) : undefined}
								onPair={(code) => onPair(box, code)}
								onScan={onScan}
								onLock={live && openKeys.has(key) ? () => onLock(box) : undefined}
							/>
						);
					})}

					<Text style={styles.hint}>
						{choosingLead
							? "Swipe left on a box to edit it, remove it from this list, or talk to its Lead."
							: "Swipe left on a box to edit it or remove it from this list."}
					</Text>

					{/* An error about one box is on its card; this is for the rest (a key that didn't save). */}
					{error ? (
						<View style={styles.errorBox}>
							<Text style={styles.errorText}>{error}</Text>
						</View>
					) : null}

					{connected ? null : (
						<>
							<View style={styles.demoRow}>
								<View style={styles.demoRule} />
								<Text style={styles.demoOr}>or</Text>
								<View style={styles.demoRule} />
							</View>
							<Pressable style={styles.demoBtn} onPress={onDemo} hitSlop={6}>
								<Text style={styles.demoText}>Try the demo, no box needed</Text>
							</Pressable>
						</>
					)}
				</View>
			</ScrollView>
			{scanner}
		</View>
	);
}

function BoxCard({
	box,
	live,
	reaching,
	asked,
	asleep,
	failure,
	note,
	steps,
	lead,
	onCancel,
	open,
	onOpenChange,
	onPress,
	onEdit,
	onSetProvider,
	onRemove,
	onLead,
	onTerminal,
	onGithub,
	onPair,
	onScan,
	onLock,
}: {
	box: SavedBox;
	live: boolean;
	reaching: boolean;
	/** The attempt reaching it was asked for, and wakes it: a tap waits for that one.
	 *  A try in the background doesn't hold up a tap, which wakes it. */
	asked: boolean;
	/** Not answering, and most likely asleep: it has a provider, and nobody woke it. */
	asleep: boolean;
	/** Why the last attempt to reach this box failed, or null. */
	failure: string | null;
	/** What the box is doing, in place of where it is (one being set up). */
	note: string | null;
	/** What reaching this box went through; empty when it isn't being reached. */
	steps: ConnectStep[];
	/** The box whose Lead the phone talks to (marked only when there's a choice). */
	lead: boolean;
	onCancel: () => void;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onPress: () => void;
	onEdit: () => void;
	/** Set the box's provider: only on a box with none that isn't answering. */
	onSetProvider?: () => void;
	onRemove: () => void;
	/** Make this the Lead's box; absent on the Lead's box itself, or with one box. */
	onLead?: () => void;
	/** The box's terminal; only on a connected box's card. */
	onTerminal?: () => void;
	/** Only on a connected box's card, like the terminal. */
	onGithub?: () => void;
	/** Pair this phone with the box using a code (shown when it's locked to others). */
	onPair: (code: string) => Promise<void>;
	/** Scan the code with the camera instead. */
	onScan: () => void;
	/** Lock the box to its paired devices: only on a connected box anyone may use. */
	onLock?: () => Promise<void>;
}) {
	const actionsWidth = ACTION_WIDTH * (onLead ? 3 : 2);
	// The responder below is made once, so it reads the width through a ref too.
	const width = useRef(actionsWidth);
	width.current = actionsWidth;
	const x = useRef(new Animated.Value(0)).current;
	// Where the card rests (0 closed, -width open), so a drag starts from there.
	const rest = useRef(0);
	// The responder is made once, so it reads the latest callback through a ref.
	const openChange = useRef(onOpenChange);
	openChange.current = onOpenChange;

	const snap = (toOpen: boolean) => {
		rest.current = toOpen ? -width.current : 0;
		Animated.spring(x, {
			toValue: rest.current,
			useNativeDriver: true,
			bounciness: 0,
			speed: 22,
		}).start();
	};

	// The parent closes this card when another opens, or when the list scrolls.
	// biome-ignore lint/correctness/useExhaustiveDependencies: snap is stable in effect
	useEffect(() => {
		if (!open && rest.current !== 0) snap(false);
	}, [open]);

	const pan = useRef(
		PanResponder.create({
			// Only a clearly horizontal drag is a swipe; anything else stays the list's scroll.
			onMoveShouldSetPanResponder: (_, g) =>
				Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
			onPanResponderMove: (_, g) => {
				x.setValue(Math.max(-width.current, Math.min(0, rest.current + g.dx)));
			},
			onPanResponderRelease: (e, g) => {
				// Judged by where the finger lifted, not by the last move: a quick flick can
				// lift well past the last move event the card was sent (x0 is the grant point).
				const at = rest.current + (e.nativeEvent.pageX - g.x0);
				const toOpen = g.vx < -0.4 || (g.vx <= 0.4 && at < -width.current / 2);
				snap(toOpen);
				openChange.current(toOpen);
			},
			onPanResponderTerminationRequest: () => false,
			onPanResponderTerminate: () => {
				snap(false);
				openChange.current(false);
			},
		}),
	).current;

	const title = boxTitle(box);
	const subtitle = boxSubtitle(box);
	// The tray shows the steps while reaching, and keeps them after a failure so the
	// failed one is visible; then the error belongs there, not in place of the address.
	const tray = steps.length > 0 && (reaching || failure !== null);
	const state = live
		? "connected"
		: reaching
			? "connecting"
			: asleep
				? "asleep"
				: failure
					? `failed: ${failure}`
					: null;

	return (
		<View>
			<View style={styles.swipe}>
				{/* Behind the card, uncovered by the swipe. Hidden from VoiceOver while
			    covered: the card offers the same two as actions. */}
				<View
					style={[styles.actions, { width: actionsWidth }]}
					accessibilityElementsHidden={!open}
					importantForAccessibility={open ? "auto" : "no-hide-descendants"}
				>
					{onLead ? (
						<Pressable
							style={[styles.action, styles.editAction]}
							onPress={() => {
								onOpenChange(false);
								onLead();
							}}
							accessibilityRole="button"
							accessibilityLabel={`Talk to the Lead on ${title}`}
						>
							<Feather name="message-circle" size={16} color={C.ink} />
							<Text style={styles.editText}>Lead</Text>
						</Pressable>
					) : null}
					<Pressable
						style={[styles.action, styles.editAction]}
						onPress={() => {
							onOpenChange(false);
							onEdit();
						}}
						accessibilityRole="button"
						accessibilityLabel={`Edit ${title}`}
					>
						<Feather name="edit-2" size={16} color={C.ink} />
						<Text style={styles.editText}>Edit</Text>
					</Pressable>
					<Pressable
						style={[styles.action, styles.removeAction]}
						onPress={() => {
							onOpenChange(false);
							onRemove();
						}}
						accessibilityRole="button"
						accessibilityLabel={`Remove ${title} from this list`}
					>
						<Feather name="x" size={16} color={REMOVE_INK} />
						<Text style={styles.removeText}>Remove</Text>
					</Pressable>
				</View>

				<Animated.View style={{ transform: [{ translateX: x }] }} {...pan.panHandlers}>
					<Pressable
						style={styles.card}
						// An open card's tap closes it; only a closed card connects.
						onPress={() => (open ? onOpenChange(false) : onPress())}
						disabled={reaching && asked && !open}
						accessibilityRole="button"
						accessibilityLabel={`${title}${lead ? ", Lead" : ""}, ${subtitle}${state ? `, ${state}` : ""}`}
						accessibilityHint={live ? "Returns to the board" : "Wakes and connects this box"}
						// The card is one VoiceOver element, so the buttons inside it are its
						// actions too, or VoiceOver couldn't reach them.
						accessibilityActions={[
							{ name: "activate" },
							...(onGithub ? [{ name: "github", label: "GitHub on this box" }] : []),
							...(onTerminal ? [{ name: "terminal", label: "Box terminal" }] : []),
							...(onLead ? [{ name: "lead", label: "Talk to this box's Lead" }] : []),
							{ name: "edit", label: "Edit" },
							{ name: "remove", label: "Remove from this list" },
						]}
						onAccessibilityAction={(e) => {
							const action = e.nativeEvent.actionName;
							if (action === "edit") onEdit();
							else if (action === "remove") onRemove();
							else if (action === "github") onGithub?.();
							else if (action === "terminal") onTerminal?.();
							else if (action === "lead") onLead?.();
							else if (!(reaching && asked)) onPress();
						}}
					>
						<ProviderIcon providerId={box.provider?.id} />
						<View style={styles.cardText}>
							<View style={styles.titleRow}>
								<Text style={styles.cardTitle} numberOfLines={1}>
									{title}
								</Text>
								{lead ? <Text style={styles.leadTag}>Lead</Text> : null}
							</View>
							<Text
								style={[styles.cardSub, failure && !tray ? styles.cardSubError : null]}
								numberOfLines={2}
							>
								{failure && !tray
									? failure
									: note
										? note
										: asleep
											? `Asleep · tap to wake · ${subtitle}`
											: subtitle}
							</Text>
						</View>
						{onGithub ? (
							<Pressable
								style={styles.terminalBtn}
								onPress={onGithub}
								hitSlop={8}
								accessibilityRole="button"
								accessibilityLabel="GitHub on this box"
							>
								<Feather name="github" size={16} color={C.ink} />
							</Pressable>
						) : null}
						{onTerminal ? (
							<Pressable
								style={styles.terminalBtn}
								onPress={onTerminal}
								hitSlop={8}
								accessibilityRole="button"
								accessibilityLabel="Box terminal"
							>
								<Feather name="terminal" size={16} color={C.ink} />
							</Pressable>
						) : null}
						{live ? (
							<Feather name="check" size={17} color={C.ink} />
						) : reaching ? (
							<ActivityIndicator color={C.muted} size="small" />
						) : asleep ? (
							<Feather name="moon" size={16} color={C.muted} />
						) : failure ? (
							<Feather name="alert-circle" size={20} color={C.red} />
						) : null}
					</Pressable>
				</Animated.View>
			</View>
			{failure === NEEDS_PAIRING ? (
				// Before the steps: a tap that ends in this keeps them, and the code field
				// is what the card is for now.
				<PairTray onPair={onPair} onScan={onScan} />
			) : tray && (reaching || !onSetProvider) ? (
				<StepTray steps={steps} failure={failure} onCancel={reaching ? onCancel : null} />
			) : onSetProvider ? (
				// Once a tap's try has ended, and through the tries after it: the failure
				// above says what happened, this says what to do about it.
				<ProviderTray onSetProvider={onSetProvider} />
			) : onLock ? (
				<LockTray onLock={onLock} />
			) : null}
		</View>
	);
}

/** Under a box with no provider that isn't answering: if it sleeps, the phone can't
 *  wake it until it knows what the box runs on. */
function ProviderTray({ onSetProvider }: { onSetProvider: () => void }) {
	return (
		<View style={styles.tray}>
			<Text style={styles.trayNote}>{NO_PROVIDER_HINT}</Text>
			<View style={styles.pairRow}>
				<Pressable
					style={[styles.pairBtn, styles.scanBtn]}
					onPress={onSetProvider}
					accessibilityRole="button"
				>
					<Text style={styles.trayBtnText}>Set provider</Text>
				</Pressable>
			</View>
		</View>
	);
}

/** Under a box locked to its paired devices: a code pairs this phone too. */
function PairTray({
	onPair,
	onScan,
}: {
	onPair: (code: string) => Promise<void>;
	onScan: () => void;
}) {
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pair = async () => {
		setBusy(true);
		setError(null);
		try {
			await onPair(code);
			setCode("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<View style={styles.tray}>
			<Text style={styles.trayText}>
				Locked to its paired devices. On your Mac, Pair a phone (Settings, Boxes) shows a code: type
				it here or scan it. `ateam pair` on the box prints a code too.
			</Text>
			<View style={styles.pairRow}>
				<TextInput
					style={styles.pairInput}
					value={code}
					onChangeText={setCode}
					placeholder="XXXX-XXXX"
					placeholderTextColor={C.faint}
					autoCapitalize="characters"
					autoCorrect={false}
					accessibilityLabel="Pairing code"
				/>
				<Pressable
					style={[styles.pairBtn, (!code.trim() || busy) && styles.pairBtnOff]}
					disabled={!code.trim() || busy}
					onPress={() => void pair()}
					accessibilityRole="button"
				>
					<Text style={styles.pairBtnText}>{busy ? "Pairing…" : "Pair"}</Text>
				</Pressable>
				<Pressable
					style={[styles.pairBtn, styles.scanBtn]}
					onPress={onScan}
					accessibilityRole="button"
					accessibilityLabel="Scan the pairing code"
				>
					<ScanQrIcon size={17} color={C.ink} />
				</Pressable>
			</View>
			{error ? <Text style={styles.pairError}>{error}</Text> : null}
		</View>
	);
}

/** Under a box anyone on the network may use: lock it, pairing this phone first. */
function LockTray({ onLock }: { onLock: () => Promise<void> }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const run = async () => {
		setBusy(true);
		setError(null);
		try {
			await onLock();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	const lock = () =>
		Alert.alert(
			"Lock this box?",
			"Only devices paired with it can use it from then on, starting with this phone. Your Mac, if it reaches the box over Tailscale, needs a code too: get one with `ateam pair` in this box's terminal (the terminal button on its card).",
			[
				{ text: "Cancel", style: "cancel" },
				{ text: "Lock it", onPress: () => void run() },
			],
		);
	return (
		<View style={styles.tray}>
			<Text style={styles.trayWarn}>
				Anyone on your Tailscale network can control this box. Lock it so only the devices you pair
				can.
			</Text>
			<View style={styles.pairRow}>
				<Pressable
					style={[styles.pairBtn, busy && styles.pairBtnOff]}
					disabled={busy}
					onPress={lock}
					accessibilityRole="button"
				>
					<Text style={styles.pairBtnText}>{busy ? "Locking…" : "Lock it"}</Text>
				</Pressable>
			</View>
			{error ? <Text style={styles.pairError}>{error}</Text> : null}
		</View>
	);
}

/** A semicard tucked under the box's card: the steps of reaching it, one per line. */
function StepTray({
	steps,
	failure,
	onCancel,
}: {
	steps: ConnectStep[];
	failure: string | null;
	/** Offered while the attempt runs; null once it has ended. */
	onCancel: (() => void) | null;
}) {
	return (
		<View style={styles.tray} accessibilityLiveRegion="polite">
			{steps.map((s, i) => (
				<View key={`${i}:${s.status}`} style={styles.stepRow}>
					<View style={styles.stepIcon}>
						{s.status === "active" ? (
							<ActivityIndicator color={C.muted} size="small" style={styles.stepSpinner} />
						) : s.status === "done" ? (
							<Feather name="check" size={13} color={C.muted} />
						) : (
							<Feather name="x" size={13} color={C.red} />
						)}
					</View>
					<Text
						style={[
							styles.stepText,
							s.status === "active" ? styles.stepActive : null,
							s.status === "failed" ? styles.stepFailed : null,
						]}
					>
						{s.label}
					</Text>
				</View>
			))}
			{failure ? <Text style={styles.trayError}>{failure}</Text> : null}
			{onCancel ? (
				<Pressable
					style={styles.cancelBtn}
					onPress={onCancel}
					hitSlop={8}
					accessibilityRole="button"
					accessibilityLabel="Stop waiting for this box"
				>
					<Text style={styles.cancelText}>Cancel</Text>
				</Pressable>
			) : null}
		</View>
	);
}

/** Dark text on the red action: white on this red falls short of legible contrast. */
const REMOVE_INK = "#15151a";
/** The tray sits a layer below the card: between the page and the card. */
const TRAY_BG = "#101013";

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg, paddingTop: 60 },
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
	spacer: { flex: 1 },
	addBtn: {
		width: 36,
		height: 36,
		borderRadius: 18,
		borderWidth: 1,
		borderColor: C.line,
		backgroundColor: C.surface,
		alignItems: "center",
		justifyContent: "center",
	},
	content: { padding: 16, paddingTop: 20, paddingBottom: 40 },
	column: { width: "100%", maxWidth: CONTENT_MAX, alignSelf: "center", gap: 10 },

	// Above the tray, which tucks under its bottom edge.
	swipe: { borderRadius: 12, overflow: "hidden", backgroundColor: C.surface, zIndex: 1 },
	actions: {
		position: "absolute",
		top: 0,
		right: 0,
		bottom: 0,
		flexDirection: "row",
	},
	action: { flex: 1, alignItems: "center", justifyContent: "center", gap: 4 },
	editAction: { backgroundColor: C.sunken },
	removeAction: { backgroundColor: C.red },
	editText: { color: C.ink, fontSize: 12, fontWeight: "700" },
	removeText: { color: REMOVE_INK, fontSize: 12, fontWeight: "700" },
	card: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingHorizontal: 14,
		paddingVertical: 12,
		backgroundColor: C.surface,
		borderWidth: 1,
		borderColor: C.line,
		borderRadius: 12,
	},
	terminalBtn: {
		width: 34,
		height: 34,
		borderRadius: 8,
		backgroundColor: C.sunken,
		alignItems: "center",
		justifyContent: "center",
	},
	cardText: { flex: 1, gap: 3 },
	titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
	cardTitle: { flexShrink: 1, color: C.ink, fontSize: 15, fontWeight: "600" },
	leadTag: {
		color: C.muted,
		fontSize: 10,
		fontWeight: "700",
		paddingHorizontal: 6,
		paddingVertical: 2,
		borderRadius: 5,
		backgroundColor: C.sunken,
		overflow: "hidden",
	},
	cardSub: { color: C.faint, fontSize: 12, fontVariant: ["tabular-nums"] },
	cardSubError: { color: C.red },

	trayText: { color: C.muted, fontSize: 13, lineHeight: 18 },
	trayWarn: { color: C.amber, fontSize: 13, lineHeight: 18 },
	trayNote: { color: C.muted, fontSize: 13, lineHeight: 18 },
	trayBtnText: { color: C.ink, fontSize: 14, fontWeight: "600" },
	pairError: { color: C.red, fontSize: 13 },
	pairRow: { flexDirection: "row", alignItems: "center", gap: 8 },
	pairInput: {
		flex: 1,
		height: 36,
		paddingHorizontal: 10,
		borderRadius: 8,
		borderWidth: 1,
		borderColor: C.line,
		color: C.ink,
		fontSize: 15,
		letterSpacing: 1,
	},
	pairBtn: {
		height: 36,
		paddingHorizontal: 14,
		borderRadius: 8,
		backgroundColor: C.ink,
		alignItems: "center",
		justifyContent: "center",
	},
	pairBtnOff: { opacity: 0.4 },
	scanBtn: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line },
	pairBtnText: { color: C.bg, fontSize: 14, fontWeight: "600" },
	tray: {
		marginTop: -12,
		marginHorizontal: 6,
		paddingTop: 20,
		paddingBottom: 10,
		paddingHorizontal: 12,
		gap: 6,
		backgroundColor: TRAY_BG,
		borderWidth: 1,
		borderTopWidth: 0,
		borderColor: C.line,
		borderBottomLeftRadius: 12,
		borderBottomRightRadius: 12,
	},
	stepRow: { flexDirection: "row", alignItems: "center", gap: 8 },
	stepIcon: { width: 16, height: 16, alignItems: "center", justifyContent: "center" },
	stepSpinner: { transform: [{ scale: 0.7 }] },
	stepText: { flex: 1, color: C.faint, fontSize: 12, fontVariant: ["tabular-nums"] },
	stepActive: { color: C.ink },
	stepFailed: { color: C.red },
	trayError: { color: C.red, fontSize: 12, lineHeight: 17, paddingLeft: 24 },
	cancelBtn: { alignSelf: "flex-end", paddingVertical: 2 },
	cancelText: { color: C.muted, fontSize: 12, fontWeight: "700" },

	hint: { color: C.faint, fontSize: 12, marginTop: 4, paddingHorizontal: 2 },
	errorBox: {
		backgroundColor: "rgba(248,113,113,0.14)",
		borderWidth: 1,
		borderColor: "rgba(248,113,113,0.4)",
		borderRadius: 8,
		padding: 12,
		marginTop: 6,
	},
	errorText: { color: C.red, fontSize: 13, lineHeight: 18 },
	demoRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 10 },
	demoRule: { flex: 1, height: 1, backgroundColor: C.line },
	demoOr: { color: C.faint, fontSize: 12 },
	demoBtn: {
		borderWidth: 1,
		borderColor: C.line,
		backgroundColor: C.surface,
		borderRadius: 10,
		paddingVertical: 13,
		alignItems: "center",
	},
	demoText: { color: C.ink, fontSize: 14, fontWeight: "700" },
});
