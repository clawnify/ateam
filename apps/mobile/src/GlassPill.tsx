// The track behind a floating pill (the header's tabs, the composer's Task |
// Lead): Liquid Glass where iOS has it (26 and later), the solid dark track
// before that. The glass is our own small module (modules/expo-glass-pill),
// since expo-glass-effect only builds for the New Architecture.
//
// A glass view must not fade through an ancestor's opacity (the effect breaks
// while it is partly transparent), so a pill that hides dissolves its glass
// (`hidden`) and the caller fades only what sits on it.
import { type StyleProp, View, type ViewProps, type ViewStyle } from "react-native";
import { NativeGlassPill } from "../modules/expo-glass-pill/src";

/** Liquid Glass draws the pills on this device. */
export const GLASS = NativeGlassPill !== null;

/** What the glass replaces in a solid track's style: its fill, rim and shadow. */
const ON_GLASS: ViewStyle = {
	backgroundColor: "transparent",
	borderWidth: 0,
	shadowOpacity: 0,
};

export function GlassPill({
	style,
	hidden = false,
	...rest
}: ViewProps & { style?: StyleProp<ViewStyle>; hidden?: boolean }) {
	if (!NativeGlassPill) return <View style={style} {...rest} />;
	return <NativeGlassPill {...rest} style={[style, ON_GLASS]} dissolved={hidden} />;
}
