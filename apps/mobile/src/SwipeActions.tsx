// A row that slides left to uncover its actions, as a box's card does in Boxes
// (BoxesScreen.tsx has its own copy, with a tray this one has no use for). Used
// for tasks on Home and the Board. One row open at a time: the list holds which,
// and closes it when it scrolls.
import Feather from "@expo/vector-icons/Feather";
import { type ComponentProps, type ReactNode, useEffect, useRef } from "react";
import {
	Animated,
	PanResponder,
	Pressable,
	type StyleProp,
	StyleSheet,
	Text,
	View,
	type ViewStyle,
} from "react-native";
import { C } from "./theme";

export interface SwipeAction {
	key: string;
	label: string;
	icon: ComponentProps<typeof Feather>["name"];
	/** Said to VoiceOver, on the button and as the row's action. */
	hint: string;
	/** Permanent: drawn red. */
	danger?: boolean;
	onPress: () => void;
}

const ACTION_WIDTH = 76;
const DANGER_INK = "#15151a";

/** What a row hands VoiceOver so its swipe actions are reachable without the swipe. */
export function swipeAccessibility(actions: SwipeAction[]) {
	return {
		accessibilityActions: [
			{ name: "activate" },
			...actions.map((a) => ({ name: a.key, label: a.hint })),
		],
		onAccessibilityAction: (
			e: { nativeEvent: { actionName: string } },
			activate: () => void,
		): void => {
			const name = e.nativeEvent.actionName;
			if (name === "activate") activate();
			else actions.find((a) => a.key === name)?.onPress();
		},
	};
}

export function SwipeActions({
	actions,
	open,
	onOpenChange,
	children,
	style,
	frontStyle,
}: {
	/** None: the row doesn't slide. */
	actions: SwipeAction[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	children: ReactNode;
	/** The clip around the row (its radius, its margins). */
	style?: StyleProp<ViewStyle>;
	/** The sliding front: it needs an opaque background to cover the actions. */
	frontStyle?: StyleProp<ViewStyle>;
}) {
	// The responder below is made once, so it reads what changes through refs.
	const width = useRef(0);
	width.current = actions.length * ACTION_WIDTH;
	const openChange = useRef(onOpenChange);
	openChange.current = onOpenChange;
	const x = useRef(new Animated.Value(0)).current;
	// Where the row rests (0 closed, -width open), so a drag starts from there.
	const rest = useRef(0);

	const snap = (toOpen: boolean) => {
		rest.current = toOpen ? -width.current : 0;
		Animated.spring(x, {
			toValue: rest.current,
			useNativeDriver: true,
			bounciness: 0,
			speed: 22,
		}).start();
	};

	// The list closes this row when another opens, or when it scrolls.
	// biome-ignore lint/correctness/useExhaustiveDependencies: snap is stable in effect
	useEffect(() => {
		if (!open && rest.current !== 0) snap(false);
	}, [open]);

	const pan = useRef(
		PanResponder.create({
			// Only a clearly horizontal drag is a swipe; anything else stays the list's scroll.
			onMoveShouldSetPanResponder: (_, g) =>
				width.current > 0 && Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
			onPanResponderMove: (_, g) => {
				x.setValue(Math.max(-width.current, Math.min(0, rest.current + g.dx)));
			},
			onPanResponderRelease: (e, g) => {
				// Judged by where the finger lifted, not by the last move: a quick flick can
				// lift well past the last move event the row was sent (x0 is the grant point).
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

	if (actions.length === 0) return <View style={style}>{children}</View>;
	return (
		<View style={[styles.clip, style]}>
			{/* Behind the row, uncovered by the swipe. Hidden from VoiceOver while
			    covered: the row offers the same ones as its actions. */}
			<View
				style={[styles.actions, { width: width.current }]}
				accessibilityElementsHidden={!open}
				importantForAccessibility={open ? "auto" : "no-hide-descendants"}
			>
				{actions.map((a) => (
					<Pressable
						key={a.key}
						style={[styles.action, a.danger && styles.danger]}
						onPress={() => {
							onOpenChange(false);
							a.onPress();
						}}
						accessibilityRole="button"
						accessibilityLabel={a.hint}
					>
						<Feather name={a.icon} size={16} color={a.danger ? DANGER_INK : C.ink} />
						<Text style={[styles.label, a.danger && styles.dangerLabel]}>{a.label}</Text>
					</Pressable>
				))}
			</View>
			<Animated.View
				style={[styles.front, frontStyle, { transform: [{ translateX: x }] }]}
				{...pan.panHandlers}
			>
				{children}
				{/* An open row's tap closes it rather than opening what it shows. */}
				{open && (
					<Pressable
						style={StyleSheet.absoluteFill}
						onPress={() => onOpenChange(false)}
						accessibilityLabel="Close actions"
						accessibilityRole="button"
					/>
				)}
			</Animated.View>
		</View>
	);
}

const styles = StyleSheet.create({
	clip: { overflow: "hidden" },
	actions: { position: "absolute", top: 0, right: 0, bottom: 0, flexDirection: "row" },
	action: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		gap: 3,
		backgroundColor: C.sunken,
	},
	danger: { backgroundColor: C.red },
	label: { color: C.ink, fontSize: 11, fontWeight: "700" },
	dangerLabel: { color: DANGER_INK },
	front: { backgroundColor: C.bg },
});
