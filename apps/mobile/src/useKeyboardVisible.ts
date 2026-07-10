import { useEffect, useState } from "react";
import { Keyboard } from "react-native";

// True while the soft keyboard is on screen. Used to drop the home-indicator
// bottom padding when the keyboard is up (the keyboard already covers that area,
// and KeyboardAvoidingView has lifted the content above it).
export function useKeyboardVisible(): boolean {
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		const show = Keyboard.addListener("keyboardWillShow", () => setVisible(true));
		const hide = Keyboard.addListener("keyboardWillHide", () => setVisible(false));
		return () => {
			show.remove();
			hide.remove();
		};
	}, []);
	return visible;
}
