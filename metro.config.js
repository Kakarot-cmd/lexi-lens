const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.unstable_enablePackageExports = false;
config.transformer.unstable_allowRequireContext = true;

module.exports = config;