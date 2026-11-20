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
    // better-auth's Expo client imports expo-network optionally; the binary has no such module, and a
    // missing module in a native bundle throws synchronously from the import (Sentry MERA-APP-A7).
    'expo-network': path.resolve(__dirname, 'lib/stubs/expo-network.ts'),
};

// mera-news-client holds the app's logic. `@/lib/*` resolves to it first and to the app's own lib/
// second; Babel leaves those specifiers alone for this. A bundle only ever uses the installed client.
const { INSTALLED_CLIENT_ROOT, refuseClientOverride } = require('./client-resolution');
refuseClientOverride('Metro');
const CLIENT_DIR = INSTALLED_CLIENT_ROOT + path.sep;
const CLIENT_LIB = path.join(INSTALLED_CLIENT_ROOT, 'lib');
const APP_LIB = path.join(__dirname, 'lib');
const APP_ORIGIN = path.join(__dirname, 'index.js');

let E2E_ATTEST_STUB = null;
let E2E_KEY_VERIFIER_STUB = null;
const E2EE_DIR = path.join(CLIENT_LIB, 'e2ee') + path.sep;

// E2E build only (scripts/e2e-android.sh exports .env.e2e): the paywall is answered by the mock
// backend's scenario, since that build carries no RevenueCat key. Same flag as app.config.js.
if (process.env.EXPO_PUBLIC_E2E === '1') {
    ALIASES['react-native-purchases-ui'] = path.resolve(__dirname, 'lib/e2e/purchases-ui.ts');
    E2E_ATTEST_STUB = path.resolve(__dirname, 'lib/e2e/device-attest.ts');
    // The mock gateway's test keys carry no Intel quote; this verifier accepts exactly those.
    E2E_KEY_VERIFIER_STUB = path.resolve(__dirname, 'lib/e2e/key-verifier.ts');
    if (process.env.E2E_DEVICE_BUILD === '1') {
        ALIASES['@react-native-community/netinfo'] = path.resolve(__dirname, 'lib/e2e/netinfo-connected.ts');
    }
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
    // By pattern: babel's module-resolver has already rewritten `@/` (all but `@/lib/`) to a relative
    // path by the time Metro resolves an import, so the `@/modules/...` spelling never reaches here.
    if (E2E_ATTEST_STUB && /(^|\/)modules\/mera-device-attest$/.test(moduleName)) {
        return context.resolveRequest(context, E2E_ATTEST_STUB, platform);
    }
    // Only imports made from the client's lib/e2ee/ (e2ee-service's './key-verifier'); the stub's own
    // import of the real module comes from the app's lib/e2e/ and resolves normally.
    if (E2E_KEY_VERIFIER_STUB && /(^|\/)key-verifier$/.test(moduleName) && context.originModulePath.startsWith(E2EE_DIR)) {
        return context.resolveRequest(context, E2E_KEY_VERIFIER_STUB, platform);
    }
    if (ALIASES[moduleName]) {
        return context.resolveRequest(context, ALIASES[moduleName], platform);
    }
    if (moduleName.startsWith('@/lib/')) {
        const rest = moduleName.slice('@/lib/'.length);
        try {
            return context.resolveRequest(context, path.join(CLIENT_LIB, rest), platform);
        } catch {
            return context.resolveRequest(context, path.join(APP_LIB, rest), platform);
        }
    }
    // A bare import made from a client file resolves in the app's node_modules, so a package the
    // client's install nested can never become a second copy of a peer (zustand, graphql, ...).
    if (context.originModulePath.startsWith(CLIENT_DIR) && !moduleName.startsWith('.') && !path.isAbsolute(moduleName)) {
        return context.resolveRequest({ ...context, originModulePath: APP_ORIGIN }, moduleName, platform);
    }
    return context.resolveRequest(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: './global.css' });