// The Ateam release this engine was built from. scripts/build.ts stamps it from the
// desktop app's version, which the release flow bumps in the commit it tags, so a
// box's engine names the release it came from. The desktop compares it with its own
// to offer an Update when a release changed the engine but not the protocol.
// Null when the engine runs from source: in tests, or as the desktop's own engine.
declare const ATEAM_RELEASE: string | undefined;

export const ENGINE_RELEASE: string | null =
	typeof ATEAM_RELEASE === "string" ? ATEAM_RELEASE : null;
