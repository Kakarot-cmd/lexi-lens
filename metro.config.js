const {
  getSentryExpoConfig
} = require("@sentry/react-native/metro");

const config = getSentryExpoConfig(__dirname);

config.resolver.unstable_enablePackageExports = false;
config.transformer.unstable_allowRequireContext = true;

module.exports = config;