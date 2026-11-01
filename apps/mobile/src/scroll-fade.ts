// Something floating over a list gets out of the way while the list scrolls: it
// fades when a drag starts and returns a moment after the list comes to rest,
// momentum included. Used for the board composer's Task | Lead switch.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ScrollViewProps } from "react-native";

export type ScrollFadeProps = Pick<
	ScrollViewProps,
	"onScrollBeginDrag" | "onScrollEndDrag" | "onMomentumScrollBegin" | "onMomentumScrollEnd"
>;

/** `faded` while the list moves; spread `scrollProps` on each list it floats over. */
export function useScrollFade(restMs = 250): { faded: boolean; scrollProps: ScrollFadeProps } {
	const [faded, setFaded] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);
	const scrollProps = useMemo<ScrollFadeProps>(() => {
		const clear = () => {
			if (timer.current) clearTimeout(timer.current);
			timer.current = null;
		};
		const showSoon = () => {
			clear();
			timer.current = setTimeout(() => setFaded(false), restMs);
		};
		return {
			onScrollBeginDrag: () => {
				clear();
				setFaded(true);
			},
			// A fling: its momentum starts right after the drag ends, so the return
			// the drag's end scheduled waits for the momentum's end instead.
			onMomentumScrollBegin: clear,
			onScrollEndDrag: showSoon,
			onMomentumScrollEnd: showSoon,
		};
	}, [restMs]);
	return { faded, scrollProps };
}
