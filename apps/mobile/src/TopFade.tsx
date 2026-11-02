// The fade behind the app's top bar (the status bar, the tabs, any banner):
// lists scroll beneath the bar and fade out as they reach it, the way iOS 26's
// bars let content pass under them. Opaque behind the status bar so the clock
// stays legible, thinning across the bar and to nothing FADE points below it.
// Drawn only behind a list: the glass pill picks up a faint texture from it.
import { StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { C } from "./theme";

/** How far the bar sits below the top of the screen: the status bar. */
export const STATUS_BAR = 60;

/** How far below the bar a list fades out as it scrolls under it. */
const FADE = 24;

/** `height`: the bar's, from the top of the screen. */
export function TopFade({ height }: { height: number }) {
	const total = height + FADE;
	return (
		<View pointerEvents="none" style={[styles.wrap, { height: total }]}>
			<Svg width="100%" height={total}>
				<Defs>
					<LinearGradient id="topFade" x1="0" y1="0" x2="0" y2="1">
						<Stop offset={0} stopColor={C.bg} stopOpacity={1} />
						<Stop offset={STATUS_BAR / total} stopColor={C.bg} stopOpacity={1} />
						<Stop offset={height / total} stopColor={C.bg} stopOpacity={0.75} />
						<Stop offset={1} stopColor={C.bg} stopOpacity={0} />
					</LinearGradient>
				</Defs>
				<Rect width="100%" height={total} fill="url(#topFade)" />
			</Svg>
		</View>
	);
}

const styles = StyleSheet.create({
	wrap: { position: "absolute", top: 0, left: 0, right: 0 },
});
