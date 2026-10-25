// The connection screen once the phone has connected somewhere: every box it has
// reached, as cards (src/boxes.ts keeps the list). Tap one to connect, swipe left to
// edit it or remove it from the list, + to add a Tailscale box. The form itself stays
// in App.tsx. The words match the desktop's Run on list (EnvironmentPicker.tsx): a
// box, Add a Tailscale box, Remove from this list, a check on the one in use.
//
// Nothing here checks a box in the background. A probe is a connection into the
// box, and connections are what keep a sleeping provider box awake, so a card only
// says what the phone already knows: which box is connected, which one it's
// reaching right now, and why the last attempt failed.
import Feather from "@expo/vector-icons/Feather";
import { type ReactNode, useEffect, useRef } from "react";
import {
	ActivityIndicator,
	Animated,
	PanResponder,
	Pressable,
	ScrollView,
	StatusBar,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { boxKey, boxSubtitle, boxTitle, type SavedBox } from "./boxes";
import { ProviderIcon } from "./ProviderIcon";
import { C, CONTENT_MAX } from "./theme";

/** How far a card slides open: room for Edit and Remove. */
const ACTIONS_WIDTH = 160;

export function BoxesScreen({
	leading,
	boxes,
	liveKey,
	attemptKey,
	failedKey,
	busy,
	error,
	connected,
	openKey,
	onSwipeOpen,
	onConnect,
	onEdit,
	onRemove,
	onAdd,
	onDisconnect,
	onDemo,
}: {
	/** The nav bar's left slot: back to the board when connected, else the logo. */
	leading: ReactNode;
	boxes: SavedBox[];
	/** The box connected now. */
	liveKey: string | null;
	/** The box a connection attempt is reaching right now. */
	attemptKey: string | null;
	/** The box the last attempt failed on; its card shows `error` in place of its address. */
	failedKey: string | null;
	/** An attempt is in flight: cards wait for it rather than start a second one. */
	busy: boolean;
	error: string | null;
	connected: boolean;
	/** The card swiped open, if any: one at a time. */
	openKey: string | null;
	onSwipeOpen: (key: string | null) => void;
	onConnect: (box: SavedBox) => void;
	onEdit: (box: SavedBox) => void;
	onRemove: (box: SavedBox) => void;
	onAdd: () => void;
	onDisconnect: () => void;
	onDemo: () => void;
}) {
	return (
		<View style={styles.root}>
			<StatusBar barStyle="light-content" backgroundColor={C.bg} />
			<View style={styles.navBar}>
				{leading}
				<Text style={styles.navTitle}>Boxes</Text>
				<View style={styles.spacer} />
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
						const failed = key === failedKey && key !== attemptKey;
						return (
							<BoxCard
								key={key}
								box={box}
								live={key === liveKey}
								reaching={key === attemptKey}
								failure={failed ? error : null}
								disabled={busy}
								open={key === openKey}
								onOpenChange={(open) => onSwipeOpen(open ? key : null)}
								onPress={() => onConnect(box)}
								onEdit={() => onEdit(box)}
								onRemove={() => onRemove(box)}
							/>
						);
					})}

					<Text style={styles.hint}>
						Swipe left on a box to edit it or remove it from this list.
					</Text>

					{/* An error about one box is on its card; this is for the rest (a key that didn't save). */}
					{error && !boxes.some((b) => boxKey(b) === failedKey && failedKey !== attemptKey) ? (
						<View style={styles.errorBox}>
							<Text style={styles.errorText}>{error}</Text>
						</View>
					) : null}

					{connected ? (
						<Pressable style={styles.disconnectBtn} onPress={onDisconnect} hitSlop={6}>
							<Text style={styles.disconnectText}>Disconnect</Text>
						</Pressable>
					) : (
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
		</View>
	);
}

function BoxCard({
	box,
	live,
	reaching,
	failure,
	disabled,
	open,
	onOpenChange,
	onPress,
	onEdit,
	onRemove,
}: {
	box: SavedBox;
	live: boolean;
	reaching: boolean;
	/** Why the last attempt to reach this box failed, or null. */
	failure: string | null;
	disabled: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onPress: () => void;
	onEdit: () => void;
	onRemove: () => void;
}) {
	const x = useRef(new Animated.Value(0)).current;
	// Where the card rests (0 closed, -ACTIONS_WIDTH open), so a drag starts from there.
	const rest = useRef(0);
	// The responder is made once, so it reads the latest callback through a ref.
	const openChange = useRef(onOpenChange);
	openChange.current = onOpenChange;

	const snap = (toOpen: boolean) => {
		rest.current = toOpen ? -ACTIONS_WIDTH : 0;
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
				x.setValue(Math.max(-ACTIONS_WIDTH, Math.min(0, rest.current + g.dx)));
			},
			onPanResponderRelease: (e, g) => {
				// Judged by where the finger lifted, not by the last move: a quick flick can
				// lift well past the last move event the card was sent (x0 is the grant point).
				const at = rest.current + (e.nativeEvent.pageX - g.x0);
				const toOpen = g.vx < -0.4 || (g.vx <= 0.4 && at < -ACTIONS_WIDTH / 2);
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
	const state = live
		? "connected"
		: reaching
			? "connecting"
			: failure
				? `failed: ${failure}`
				: null;

	return (
		<View style={styles.swipe}>
			{/* Behind the card, uncovered by the swipe. Hidden from VoiceOver while
			    covered: the card offers the same two as actions. */}
			<View
				style={styles.actions}
				accessibilityElementsHidden={!open}
				importantForAccessibility={open ? "auto" : "no-hide-descendants"}
			>
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
					disabled={disabled && !open}
					accessibilityRole="button"
					accessibilityLabel={`${title}, ${subtitle}${state ? `, ${state}` : ""}`}
					accessibilityHint={live ? "Returns to the board" : "Connects to this box"}
					accessibilityActions={[
						{ name: "activate" },
						{ name: "edit", label: "Edit" },
						{ name: "remove", label: "Remove from this list" },
					]}
					onAccessibilityAction={(e) => {
						if (e.nativeEvent.actionName === "edit") onEdit();
						else if (e.nativeEvent.actionName === "remove") onRemove();
						else if (!disabled) onPress();
					}}
				>
					<ProviderIcon providerId={box.provider?.id} />
					<View style={styles.cardText}>
						<Text style={styles.cardTitle} numberOfLines={1}>
							{title}
						</Text>
						<Text style={[styles.cardSub, failure ? styles.cardSubError : null]} numberOfLines={2}>
							{failure ?? subtitle}
						</Text>
					</View>
					{live ? (
						<Feather name="check" size={17} color={C.ink} />
					) : reaching ? (
						<ActivityIndicator color={C.muted} size="small" />
					) : failure ? (
						<Feather name="alert-circle" size={20} color={C.red} />
					) : null}
				</Pressable>
			</Animated.View>
		</View>
	);
}

/** Dark text on the red action: white on this red falls short of legible contrast. */
const REMOVE_INK = "#15151a";

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

	swipe: { borderRadius: 12, overflow: "hidden", backgroundColor: C.surface },
	actions: {
		position: "absolute",
		top: 0,
		right: 0,
		bottom: 0,
		width: ACTIONS_WIDTH,
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
	cardText: { flex: 1, gap: 3 },
	cardTitle: { color: C.ink, fontSize: 15, fontWeight: "600" },
	cardSub: { color: C.faint, fontSize: 12, fontVariant: ["tabular-nums"] },
	cardSubError: { color: C.red },

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
	disconnectBtn: {
		marginTop: 10,
		borderWidth: 1,
		borderColor: "rgba(248,113,113,0.4)",
		borderRadius: 10,
		paddingVertical: 12,
		alignItems: "center",
	},
	disconnectText: { color: C.red, fontSize: 14, fontWeight: "700" },
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
