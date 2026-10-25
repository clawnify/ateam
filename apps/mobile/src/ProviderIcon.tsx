// A provider's mark in a square tile, for the Boxes list and the Provider picker
// (the marks are in src/provider-logos.ts). A box with no provider gets a server
// glyph in the same tile, so every row lines up.
import Feather from "@expo/vector-icons/Feather";
import { StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { PROVIDER_LOGOS } from "./provider-logos";
import { C } from "./theme";

export function ProviderIcon({
	providerId,
	size = 40,
}: {
	providerId: string | null | undefined;
	size?: number;
}) {
	const logo = providerId ? PROVIDER_LOGOS[providerId] : undefined;
	const glyph = Math.round(size * 0.5);
	return (
		// Decorative: the row it sits in already names the provider.
		<View
			style={[styles.tile, { width: size, height: size, borderRadius: Math.round(size * 0.25) }]}
			accessible={false}
			importantForAccessibility="no-hide-descendants"
		>
			{logo ? (
				<Svg width={glyph} height={glyph} viewBox={logo.viewBox}>
					<Path d={logo.d} fill={logo.fill ?? C.ink} />
				</Svg>
			) : (
				<Feather name="server" size={glyph} color={C.muted} />
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	tile: {
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: C.sunken,
		borderWidth: 1,
		borderColor: C.line,
	},
});
