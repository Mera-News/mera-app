const { withNativeWind } = require('nativewind/metro');
const path = require('path');
const {
    getSentryExpoConfig
} = require("@sentry/react-native/metro");

const config = getSentryExpoConfig(__dirname);

config.resolver.unstable_enablePackageExports = true;
// Add support for .cjs files for Apollo Client
config.resolver.sourceExts.push("cjs");

// Ensure Metro can find assets in the assets directory
config.resolver.assetExts = config.resolver.assetExts || [];
config.watchFolders = config.watchFolders || [];
config.watchFolders.push(path.resolve(__dirname, 'assets'));

// Fix for tslib error with Apollo Client
const ALIASES = {
    'tslib': require.resolve('tslib/tslib.es6.js'),
};

config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (ALIASES[moduleName]) {
        return context.resolveRequest(context, ALIASES[moduleName], platform);
    }
    return context.resolveRequest(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: './global.css' });