import { requireOptionalNativeModule } from "expo";

// Absent from a build that predates the module.
const tailnet = requireOptionalNativeModule<{ isUp(): boolean }>("ExpoTailnet");

/** Whether this phone is on a tailnet right now (Tailscale connected), or null where
 *  this build can't tell. */
export function onTailnet(): boolean | null {
	return tailnet ? tailnet.isUp() : null;
}
