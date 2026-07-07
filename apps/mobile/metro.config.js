// Metro, isolated to this app's own node_modules. apps/mobile sits inside a bun
// workspace whose root node_modules would otherwise shadow react/react-native and
// version-clash. Pinning resolution here keeps the RN bundle self-contained (the
// preview imports only react + react-native — no workspace packages yet).
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];
config.resolver.disableHierarchicalLookup = true;

// Surgically link the one workspace package the app consumes — @ateam/protocol,
// the pure-TS wire contract (no deps of its own). We watch its folder so Metro
// transpiles its source, and map just its name, WITHOUT reopening hierarchical
// lookup — so the bun-root node_modules still can't shadow react/react-native.
const protocolDir = path.resolve(projectRoot, "../../packages/protocol");
config.watchFolders = [protocolDir];
config.resolver.extraNodeModules = { "@ateam/protocol": protocolDir };

module.exports = config;
