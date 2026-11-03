// app.json is the release app (Ateam Go, com.clawnify.ateam, scheme ateamgo) and
// stays the source of truth: the release scripts bump ios.buildNumber there.
//
// APP_VARIANT=development turns it into "Ateam Go Dev", a separate app with its
// own bundle id and URL scheme, so a Debug build with expo-dev-client installs
// next to the TestFlight / App Store app instead of replacing it. Build it with
// `npm run ios:dev`. `expo run:ios` only prebuilds when ios/ is missing, so that
// script always prebuilds with --clean: an ios/ left over from the other variant
// would keep that variant's bundle id.
const IS_DEV = process.env.APP_VARIANT === "development";

module.exports = ({ config }) => {
	// Expo applies expo-dev-client's config plugin automatically once the package
	// is installed, and the plugin registers an extra `exp+<slug>` URL scheme.
	// Release builds list it with that scheme off so their Info.plist stays as it
	// was. The dev build keeps it: it is how a link opens a Metro URL in the app.
	const devClient = IS_DEV ? "expo-dev-client" : ["expo-dev-client", { addGeneratedScheme: false }];
	const plugins = [...(config.plugins ?? []), devClient];
	if (!IS_DEV) return { ...config, plugins };
	return {
		...config,
		name: "Ateam Go Dev",
		scheme: "ateamgo-dev",
		plugins,
		ios: { ...config.ios, bundleIdentifier: "com.clawnify.ateam.dev" },
	};
};
