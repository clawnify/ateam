import { requireNativeView } from "expo";
import * as React from "react";
import type { StyleProp, ViewStyle } from "react-native";

// The native SwiftTerm view (a UIScrollView-backed terminal). Events flow up as
// { nativeEvent: {...} }; PTY bytes flow down via the imperative `feed` handle
// (a view function — not a prop — so streamed chunks are never dropped).
const NativeView: React.ComponentType<{
	style?: StyleProp<ViewStyle>;
	onInput?: (e: { nativeEvent: { data: string } }) => void;
	onSizeChange?: (e: { nativeEvent: { cols: number; rows: number } }) => void;
	ref?: React.Ref<{ feed(text: string): Promise<void> }>;
}> = requireNativeView("ExpoSwiftterm");

export interface SwiftTermHandle {
	feed(text: string): void;
}

export interface SwiftTermViewProps {
	style?: StyleProp<ViewStyle>;
	onInput?: (data: string) => void;
	onSizeChange?: (cols: number, rows: number) => void;
}

export const SwiftTermView = React.forwardRef<SwiftTermHandle, SwiftTermViewProps>(
	({ style, onInput, onSizeChange }, ref) => {
		const nativeRef = React.useRef<{ feed(text: string): Promise<void> }>(null);
		React.useImperativeHandle(ref, () => ({
			feed: (text: string) => {
				void nativeRef.current?.feed(text);
			},
		}));
		return (
			<NativeView
				ref={nativeRef}
				style={style}
				onInput={(e) => onInput?.(e.nativeEvent.data)}
				onSizeChange={(e) => onSizeChange?.(e.nativeEvent.cols, e.nativeEvent.rows)}
			/>
		);
	},
);
