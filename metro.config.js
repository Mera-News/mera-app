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
// A mutation run rewrites thousands of files here, which kills Metro's watcher.
config.resolver.blockList = [].concat(config.resolver.blockList ?? [], /\/\.stryker-tmp\//, /\/coverage\//);
config.watchFolders = config.watchFolders || [];
config.watchFolders.push(path.resolve(__dirname, 'assets'));

// Fix for tslib error with Apollo Client
const ALIASES = {
    'tslib': require.resolve('tslib/tslib.es6.js'),
};

let E2E_ATTEST_STUB = null;

// E2E build only (scripts/e2e-android.sh exports .env.e2e): the paywall is answered by the mock
// backend's scenario, since that build carries no RevenueCat key. Same flag as app.config.js.
if (process.env.EXPO_PUBLIC_E2E === '1') {
    ALIASES['react-native-purchases-ui'] = path.resolve(__dirname, 'lib/e2e/purchases-ui.ts');
    E2E_ATTEST_STUB = path.resolve(__dirname, 'lib/e2e/device-attest.ts');
    if (process.env.E2E_DEVICE_BUILD === '1') {
        ALIASES['@react-native-community/netinfo'] = path.resolve(__dirname, 'lib/e2e/netinfo-connected.ts');
    }
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
    // By pattern: babel's module-resolver has already rewritten `@/` to a relative path by the time
    // Metro resolves an import, so the `@/modules/...` spelling never reaches this function.
    if (E2E_ATTEST_STUB && /(^|\/)modules\/mera-device-attest$/.test(moduleName)) {
        return context.resolveRequest(context, E2E_ATTEST_STUB, platform);
    }
    if (ALIASES[moduleName]) {
        return context.resolveRequest(context, ALIASES[moduleName], platform);
    }
    return context.resolveRequest(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: './global.css' });