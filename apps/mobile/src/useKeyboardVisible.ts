import { useEffect, useState } from "react";
import { Dimensions, Keyboard, type KeyboardEvent } from "react-native";

// True while the soft keyboard is on screen. Used to drop the home-indicator
// bottom padding when the keyboard is up (the keyboard already covers that area,
// and KeyboardAvoidingView has lifted the content above it).
//
// Judged by the keyboard's end frame rather than show/hide events: the native
// terminal hides its keyboard by swapping in an empty input view, which iOS
// reports as a (zero-height) keyboard frame change, not as a hide.
export function useKeyboardVisible(): boolean {
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		const onFrame = (e: KeyboardEvent) => {
			const { height, screenY } = e.endCoordinates;
			setVisible(height > 0 && screenY < Dimensions.get("screen").height);
		};
		const change = Keyboard.addListener("keyboardWillChangeFrame", onFrame);
		const hide = Keyboard.addListener("keyboardWillHide", () => setVisible(false));
		return () => {
			change.remove();
			hide.remove();
		};
	}, []);
	return visible;
}
