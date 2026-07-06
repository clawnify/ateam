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

module.exports = config;
