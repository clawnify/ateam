// Metro, isolated to this app's own node_modules. apps/mobile sits inside a bun
// workspace whose root node_modules would otherwise shadow react/react-native and
// version-clash. Pinning resolution here keeps the RN bundle self-contained (the
// preview imports only react + react-native — no workspace packages yet).
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

// Resolve this app's own node_modules first. We deliberately KEEP Metro's
// hierarchical (walk-up) lookup on: SDK 54's `expo` pulls in transitive deps that
// npm nests (e.g. whatwg-url-without-unicode → its own webidl-conversions), and
// disabling the walk-up makes those nested modules unresolvable. The original
// bun-root-shadowing concern is now handled structurally — apps/mobile is excluded
// from the bun workspace ("!apps/mobile") with its own lockfile + isolated
// node_modules, and closest-wins resolution means the app's own react/react-native
// always win for app code.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];

// Link the shared wire contract and pane-layout rules without exposing the
// workspace root's React dependencies to Metro.
const protocolDir = path.resolve(projectRoot, "../../packages/protocol");
const panesDir = path.resolve(projectRoot, "../../packages/panes");
config.watchFolders = [protocolDir, panesDir];
config.resolver.extraNodeModules = { "@ateam/protocol": protocolDir, "@ateam/panes": panesDir };

module.exports = config;
