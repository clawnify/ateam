// electron-builder afterSign hook: notarize the signed .app with credentials
// stored in a keychain profile (created once via:
//   xcrun notarytool store-credentials ateam-notary \
//     --apple-id <you@example.com> --team-id <TEAMID> --password <app-specific>
// ), then staple the ticket so Gatekeeper passes offline.
// Skips cleanly when the profile isn't set up or SKIP_NOTARIZE=1.
const { execSync } = require("node:child_process");

exports.default = async function notarizeHook(context) {
	if (context.electronPlatformName !== "darwin") return;
	if (process.env.SKIP_NOTARIZE === "1") {
		console.log("[notarize] SKIP_NOTARIZE=1 — skipping");
		return;
	}
	const profile = process.env.NOTARY_PROFILE || "ateam-notary";
	try {
		execSync(`xcrun notarytool history --keychain-profile ${profile}`, {
			stdio: "ignore",
		});
	} catch {
		console.warn(
			`[notarize] keychain profile "${profile}" not found — skipping notarization`,
		);
		return;
	}

	const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
	console.log(`[notarize] submitting ${appPath} (this can take a few minutes)…`);
	const { notarize } = require("@electron/notarize");
	await notarize({ appPath, keychainProfile: profile });
	execSync(`xcrun stapler staple "${appPath}"`, { stdio: "inherit" });
	console.log("[notarize] notarized + stapled");
};
