// The app's side of mera-news-client: everything the client takes from its host, then the
// registration. index.js imports this file first, before anything that reaches the client, because
// about 30 client modules read the platform while they load (the database, config/endpoints).
//
// Every member that holds a module requires it when it is read, never at the top of this file:
// - nearly every app module imports the client's logger, stores or endpoints, so importing one here
//   would load a client module before registerPlatform runs and throw PlatformNotRegisteredError at
//   launch, on every device;
// - Jest loads this file once per test file, before that file's jest.mock calls register, so a module
//   captured at import would bypass the test's mock. The facades read the host at call time, so a
//   require here costs nothing after the first one.
import { registerPlatform, type OnDeviceModel, type PlatformHost } from '@/lib/platform';
import type { DecisionRequest } from 'llama.rn';

/* eslint-disable @typescript-eslint/no-require-imports */

const toolkit = (): typeof import('@/lib/mera-protocol-toolkit') => require('@/lib/mera-protocol-toolkit');
const authClient = (): typeof import('@/lib/auth-client') => require('@/lib/auth-client');
const breaker = (): typeof import('@/lib/auth-failure-breaker') => require('@/lib/auth-failure-breaker');
const translation = (): typeof import('@/lib/translation-service') => require('@/lib/translation-service');

const onDeviceModel: OnDeviceModel = {
  infer: (params) => toolkit().infer(params),
  inferStream: (params, signal) => toolkit().inferStream(params, signal),
  inferStructured: <T,>(params: Parameters<OnDeviceModel['inferStructured']>[0]) => toolkit().inferStructured<T>(params),
  decide: <R extends DecisionRequest>(request: R) => toolkit().decide(request),
  contextSize: (engine) => toolkit().contextSize(engine),
  resetContext: () => toolkit().resetContext(),
  getTextEngine: () => toolkit().getTextEngine(),
};

/** The app's own entries in hydrateAllStores; each one settles on its own and a failure is reported. */
async function hydrateAppState(): Promise<void> {
  const results = await Promise.allSettled([
    require('@/lib/stores/display-prefs-store').useDisplayPrefsStore.getState().hydrate(),
    require('@/lib/stores/text-scale-store').useTextScaleStore.getState().hydrate(),
    require('@/lib/stores/startup-tab-store').useStartupTabStore.getState().hydrate(),
    // The memoised page-order load, the same promise the startup gate awaits. Never rejects.
    require('@/lib/navigation/page-order').loadPageOrders(),
    // The Mera button's saved corner, so the button never paints in the default corner and jumps.
    require('@/components/custom/mera-button/corner').hydrateMeraButtonCorner(),
    // The Feed's view and minimap rows, the same memoised load the startup gate awaits.
    require('@/components/custom/feed/feed-view-prefs').loadFeedViewPrefs(),
    // The backup preferences mirror, then the OS task re-synced to the hydrated cadence: the only
    // moment the cadence is known to be right. Never rejects.
    require('@/lib/backup/backup-settings')
      .hydrateBackupSettings()
      .then(() => require('@/lib/background/backup-task').syncBackupTaskRegistration())
      .catch(() => undefined),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') {
      require('@/lib/logger').default.captureException(result.reason, {
        tags: { module: 'hydrate-stores', step: 'hydrate-entry' },
      });
    }
  }
}

/** The app's own state, cleared after the client has emptied the database and its stores. */
async function resetAppState(): Promise<void> {
  require('@/lib/stores/subscription-store').useSubscriptionStore.getState().reset();
  require('@/lib/stores/startup-tab-store').useStartupTabStore.getState().reset();
  // Page orders: the rows went with the database, so the memory copy and the memoised load go too,
  // or the next account opens tabs in this one's order.
  require('@/lib/navigation/page-order').resetPageOrders();
  // The nav shell's memory: which page is on screen and a page jump still waiting for its tab.
  require('@/components/custom/nav/current-surface').resetCurrentSurface();
  require('@/components/custom/nav/navigate-to-page').resetPendingPage();
  require('@/components/custom/mera-button/corner').resetMeraButtonCorner();
  require('@/components/custom/feed/feed-view-prefs').resetFeedViewPrefs();
  // LAST, and deliberately so: the device's memory of its last resolved subscription tier. Without
  // it, user B on user A's device inherits A's tier and walks past the pre-onboarding entitlement
  // gate as a subscriber. The tier is written by a fire-and-forget `recordResolvedTier()` that reads
  // the subscription store, so a straggler from a gate pass already in flight at logout could
  // re-write the outgoing user's tier until every reset above has run. Explicit rather than relying
  // on `unsafeResetDatabase()` dropping the row: this is the line a future reader greps for.
  await require('@/lib/subscription/last-known-tier').clearLastKnownTier();
}

/** Development only: keeps the plaintext of an inference job under Documents/prompt-dumps. */
function devDump(fileName: string, text: string): void {
  const { Directory, File, Paths } = require('expo-file-system');
  const dir = new Directory(Paths.document, 'prompt-dumps');
  if (!dir.exists) dir.create({ intermediates: true });
  const file = new File(dir, fileName);
  file.create();
  file.write(text);
}

const host: PlatformHost = {
  isDev: __DEV__,
  // Literal reads only: Metro inlines `process.env.EXPO_PUBLIC_X` written out in full, never a
  // computed key. Read on each access, so a test's change is seen. Exactly the keys the client
  // reads; never the test-account token.
  get env() {
    return {
      EXPO_PUBLIC_INFERENCE_ENDPOINT: process.env.EXPO_PUBLIC_INFERENCE_ENDPOINT,
      EXPO_PUBLIC_AUTH_ENDPOINT: process.env.EXPO_PUBLIC_AUTH_ENDPOINT,
      EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT: process.env.EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT,
      EXPO_PUBLIC_DEV_RESTORE_TEST: process.env.EXPO_PUBLIC_DEV_RESTORE_TEST,
      EXPO_PUBLIC_DUMP_QUERY_FOR_DEBUGGING: process.env.EXPO_PUBLIC_DUMP_QUERY_FOR_DEBUGGING,
      EXPO_PUBLIC_FORCE_UPDATE_IN_DEV: process.env.EXPO_PUBLIC_FORCE_UPDATE_IN_DEV,
      EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
      EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
      EXPO_PUBLIC_INTERCOM_ANDROID_KEY: process.env.EXPO_PUBLIC_INTERCOM_ANDROID_KEY,
      EXPO_PUBLIC_INTERCOM_APP_ID: process.env.EXPO_PUBLIC_INTERCOM_APP_ID,
      EXPO_PUBLIC_INTERCOM_IOS_KEY: process.env.EXPO_PUBLIC_INTERCOM_IOS_KEY,
      EXPO_PUBLIC_RESTART_DEBUG: process.env.EXPO_PUBLIC_RESTART_DEBUG,
      EXPO_PUBLIC_REVENUECAT_ANDROID_KEY: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY,
      EXPO_PUBLIC_REVENUECAT_API_KEY: process.env.EXPO_PUBLIC_REVENUECAT_API_KEY,
      EXPO_PUBLIC_REVENUECAT_IOS_KEY: process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY,
      EXPO_PUBLIC_SHOW_EXTRACTED_METADATA_IN_DEV: process.env.EXPO_PUBLIC_SHOW_EXTRACTED_METADATA_IN_DEV,
      EXPO_PUBLIC_VERBOSE_LOGS: process.env.EXPO_PUBLIC_VERBOSE_LOGS,
    };
  },

  get appState() {
    return require('react-native').AppState;
  },
  devReload: (reason) => require('react-native').DevSettings.reload(reason),
  get keepAwake() {
    return require('expo-keep-awake');
  },
  get updates() {
    return require('expo-updates');
  },
  getCurrentPathname: () => require('@/lib/nav-state').getCurrentPathname(),
  captureSpot: () => require('@/lib/navigation/resume-spot').captureSpot(),

  get sentry() {
    return require('@sentry/react-native');
  },
  submitFeatureRequest: (title, summary) => require('@/lib/feedback').submitFeatureRequest(title, summary),
  devDump,

  get fetch() {
    return require('expo/fetch').fetch as typeof globalThis.fetch;
  },
  isRequestTimeoutError: (error) => require('@/lib/apollo-fetch').isRequestTimeoutError(error),
  get netInfo() {
    return require('@react-native-community/netinfo').default;
  },

  get asyncStorage() {
    return require('@react-native-async-storage/async-storage').default;
  },
  get secureStore() {
    return require('@/lib/utils/secure-store-adapter').secureStore;
  },
  getLocales: () => require('expo-localization').getLocales(),

  auth: {
    getJwtToken: () => authClient().getJwtToken(),
    invalidateJwtCache: () => authClient().invalidateJwtCache(),
    getCookie: () => authClient().authClient.getCookie(),
    recordAuthFailure: () => breaker().recordAuthFailure(),
    onAppForeground: () => breaker().onAppForeground(),
    onNetworkReconnect: () => breaker().onNetworkReconnect(),
  },
  get apolloClient() {
    return require('@/lib/apollo-client').default;
  },
  createDatabaseAdapter: (options) => {
    const SQLiteAdapter = require('@nozbe/watermelondb/adapters/sqlite').default;
    return new SQLiteAdapter(options);
  },

  get i18n() {
    return require('@/lib/i18n').default;
  },
  applyLanguage: (lang) => require('@/lib/i18n').applyLanguage(lang),
  canTranslateIntoLanguage: (lang, osMajor) => translation().canTranslateIntoLanguage(lang, osMajor),
  clearTranslationFailuresFor: (lang) => translation().clearTranslationFailuresFor(lang),
  setLateTranslationSink: (sink) => translation().setLateTranslationSink(sink),
  bumpTranslationEpoch: (reason) => require('@/lib/translation-queue').bumpTranslationEpoch(reason),

  showNotifiedToast: (row, opts) => require('@/lib/toast-manager').toastManager.showNotifiedRowToast(row, opts),
  showDialog: (options) => require('@/lib/dialog').showDialog(options),
  hapticLight: () => require('@/lib/haptics').hapticLight(),

  onDeviceModel,

  recordForeground: (at) => require('@/lib/background/bg-refresh-settings').recordForeground(at),
  runKeychainAccessibilityMigration: () =>
    require('@/lib/utils/keychain-accessibility-migration').runKeychainAccessibilityMigration(),
  hydrateHostState: hydrateAppState,
  resetHostState: resetAppState,
};

registerPlatform(host);
