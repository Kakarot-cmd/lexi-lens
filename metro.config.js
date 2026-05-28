const {
  getSentryExpoConfig
} = require("@sentry/react-native/metro");

const config = getSentryExpoConfig(__dirname);

config.resolver.unstable_enablePackageExports = false;
config.transformer.unstable_allowRequireContext = true;

// ─── Lumi Rive (v6.8) ────────────────────────────────────────────────────────
// Allow `require('../assets/lumi/lumi.riv')` to resolve through Metro's asset
// pipeline. Without this, Metro treats the unknown extension as a JS module
// and the require throws at bundle time. Adding the extension is safe on
// both iOS and Android (Metro produces the right native bundle entry for
// each platform automatically). Harmless when LUMI_RIVE_ENABLED is false.
if (!config.resolver.assetExts.includes('riv')) {
  config.resolver.assetExts.push('riv');
}

module.exports = config;
