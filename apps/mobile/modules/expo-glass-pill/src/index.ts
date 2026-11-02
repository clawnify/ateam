import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { ViewProps } from "react-native";

export type NativeGlassPillProps = ViewProps & {
	/** Animate the glass away (true) or back. */
	dissolved?: boolean;
};

// Absent from a build that predates the module; `available` is false before iOS 26.
const glass = requireOptionalNativeModule<{ available: boolean }>("ExpoGlassPill");

/** The native glass capsule, or null where there is no Liquid Glass. */
export const NativeGlassPill = glass?.available
	? requireNativeView<NativeGlassPillProps>("ExpoGlassPill")
	: null;
