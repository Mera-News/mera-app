// Deliberately does NOT mock ./runtime-context. Mocking it wholesale would make
// the privacy guard at the bottom vacuous — it would only be asserting on a
// literal this file wrote. The five stores are stubbed thinly instead, so the
// real getRuntimeContext() runs and the assertions are made against the tag keys
// that would actually ship.

const mockSetUser = jest.fn();
const mockSetTag = jest.fn();
const mockSetContext = jest.fn();

jest.mock('@sentry/react-native', () => ({
  init: jest.fn(),
  setUser: mockSetUser,
  setTag: mockSetTag,
  setContext: mockSetContext,
  feedbackIntegration: jest.fn(() => ({})),
  captureException: jest.fn(),
}));

jest.mock('expo-application', () => ({
  nativeApplicationVersion: '1.2.3',
  nativeBuildVersion: '456',
}));
jest.mock('expo-updates', () => ({
  updateId: 'update-abc',
  channel: 'production',
  runtimeVersion: '1.2.3',
  isEmbeddedLaunch: false,
}));

// Zustand-shaped stubs: getState() + subscribe() returning an unsubscribe. The
// real stores drag in WatermelonDB, Apollo and the RevenueCat SDK; none of that
// is what this module is about.
function mockMakeStore(state: Record<string, unknown>) {
  const subscribe = jest.fn(() => jest.fn());
  return { getState: () => state, subscribe };
}

const mockLanguageStore = mockMakeStore({ appLanguage: 'en' });
const mockSubscriptionStore = mockMakeStore({ tier: 'pro', serverTier: 'pro' });
const mockMeraStore = mockMakeStore({
  processingMode: 'CLOUD',
  relevanceV3: true,
  modelState: 'not_downloaded',
});
const mockNetworkStore = mockMakeStore({ isConnected: true, serverReachable: false });
const mockUserStore = mockMakeStore({ userPersona: { onboardingStage: 'COMPLETE' } });

jest.mock('@/lib/stores/app-language-store', () => ({
  useAppLanguageStore: mockLanguageStore,
}));
jest.mock('@/lib/stores/subscription-store', () => ({
  useSubscriptionStore: mockSubscriptionStore,
}));
jest.mock('@/lib/stores/mera-protocol-store', () => ({
  useMeraProtocolStore: mockMeraStore,
}));
jest.mock('@/lib/stores/network-store', () => ({
  useNetworkStore: mockNetworkStore,
}));
jest.mock('@/lib/stores/user-store', () => ({ useUserStore: mockUserStore }));

type ScopeModule = typeof import('../sentry-scope');

function loadScope(): ScopeModule {
  // SENTRY_ENABLED is computed at sentry-init module load from __DEV__, so the
  // module graph has to be rebuilt per case with the flag already set.
  (global as any).__DEV__ = false;
  process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://test@sentry.io/1';
  let mod!: ScopeModule;
  jest.isolateModules(() => {
    mod = require('../sentry-scope');
  });
  // Loading the graph runs lib/sentry-init.ts, which sets the STATIC build tags
  // as a module side effect. Clear here so each case asserts only on what
  // sentry-scope itself emitted.
  jest.clearAllMocks();
  return mod;
}

describe('sentry-scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    (global as any).__DEV__ = true;
  });

  describe('applySentryUser', () => {
    it('sets user.id only', () => {
      loadScope().applySentryUser('68f0c0ffee0000000000beef');
      expect(mockSetUser).toHaveBeenCalledWith({
        id: '68f0c0ffee0000000000beef',
      });
    });

    it('never sets email, username or ip_address', () => {
      loadScope().applySentryUser('u1');
      const [payload] = mockSetUser.mock.calls[0];
      expect(Object.keys(payload)).toEqual(['id']);
    });

    it('clears the user with null on logout', () => {
      loadScope().applySentryUser(null);
      expect(mockSetUser).toHaveBeenCalledWith(null);
    });

    it('is a no-op when Sentry is disabled (dev without the opt-in flag)', () => {
      (global as any).__DEV__ = true;
      delete process.env.EXPO_PUBLIC_SENTRY_IN_DEV;
      let mod!: ScopeModule;
      jest.isolateModules(() => {
        mod = require('../sentry-scope');
      });
      mod.applySentryUser('u1');
      expect(mockSetUser).not.toHaveBeenCalled();
    });
  });

  describe('refreshSentryScope', () => {
    it('emits one tag per runtime-context field', () => {
      loadScope().refreshSentryScope();
      const emitted = Object.fromEntries(mockSetTag.mock.calls);
      expect(emitted).toEqual({
        subscription_tier: 'pro',
        server_tier: 'pro',
        app_language: 'en',
        onboarding_stage: 'COMPLETE',
        processing_mode: 'CLOUD',
        relevance_v3: 'true',
        free_tier_mode: expect.any(String),
        model_state: 'not_downloaded',
        network_connected: 'true',
        server_reachable: 'false',
      });
    });

    it('coerces boolean tag values to strings', () => {
      loadScope().refreshSentryScope();
      for (const [, value] of mockSetTag.mock.calls) {
        expect(typeof value).toBe('string');
      }
    });

    it('merges the static build facts into the mera_app_state context', () => {
      loadScope().refreshSentryScope();
      expect(mockSetContext).toHaveBeenCalledWith(
        'mera_app_state',
        expect.objectContaining({
          ota_update_id: 'update-abc',
          subscription_tier: 'pro',
        }),
      );
    });

    it('skips a repeat emission when nothing changed', () => {
      // Store subscriptions fire on every download-progress tick; re-crossing
      // the native bridge with identical values ~10x per tick is the cost this
      // guard exists to avoid.
      const scope = loadScope();
      scope.refreshSentryScope();
      const firstCallCount = mockSetTag.mock.calls.length;
      scope.refreshSentryScope();
      expect(mockSetTag.mock.calls.length).toBe(firstCallCount);
    });

    it('is a no-op when Sentry is disabled', () => {
      (global as any).__DEV__ = true;
      delete process.env.EXPO_PUBLIC_SENTRY_IN_DEV;
      let mod!: ScopeModule;
      jest.isolateModules(() => {
        mod = require('../sentry-scope');
      });
      mod.refreshSentryScope();
      expect(mockSetTag).not.toHaveBeenCalled();
    });
  });

  describe('startSentryScopeSync', () => {
    it('emits immediately and subscribes to all five stores', () => {
      const stop = loadScope().startSentryScopeSync();
      expect(mockSetTag).toHaveBeenCalled();
      expect(mockLanguageStore.subscribe).toHaveBeenCalled();
      expect(mockSubscriptionStore.subscribe).toHaveBeenCalled();
      expect(mockMeraStore.subscribe).toHaveBeenCalled();
      expect(mockNetworkStore.subscribe).toHaveBeenCalled();
      expect(mockUserStore.subscribe).toHaveBeenCalled();
      stop();
    });

    it('tears every subscription down', () => {
      const stop = loadScope().startSentryScopeSync();
      const unsubscribes = [
        mockLanguageStore.subscribe,
        mockSubscriptionStore.subscribe,
        mockMeraStore.subscribe,
        mockNetworkStore.subscribe,
        mockUserStore.subscribe,
      ].map((s) => s.mock.results[s.mock.results.length - 1].value);
      stop();
      for (const unsubscribe of unsubscribes) {
        expect(unsubscribe).toHaveBeenCalled();
      }
    });

    it('returns a harmless teardown when Sentry is disabled', () => {
      (global as any).__DEV__ = true;
      delete process.env.EXPO_PUBLIC_SENTRY_IN_DEV;
      let mod!: ScopeModule;
      jest.isolateModules(() => {
        mod = require('../sentry-scope');
      });
      const stop = mod.startSentryScopeSync();
      expect(() => stop()).not.toThrow();
      expect(mockLanguageStore.subscribe).not.toHaveBeenCalled();
    });
  });

  // The product invariant: no collection links a user to a topic, and the
  // privacy policy states we do not collect article-level behaviour. A tag is a
  // collection. This asserts on the REAL emitted key set, so a future field
  // added to runtime-context.ts trips it rather than sliding through.
  describe('privacy guard', () => {
    const FORBIDDEN = [
      'persona',
      'fact',
      'topic',
      'interest',
      'location',
      'country',
      'article',
      'read',
      'history',
      'email',
      'name',
      'query',
      'search',
      'headline',
      'publisher',
      'saved',
      'push',
      'idfa',
      'idfv',
      // NB: 'ip' is deliberately absent — it is a substring of "subscription".
      // ip_address is a `user` field, and beforeSend's allowlist covers it.
    ];

    it('emits no tag key naming persona, topic, location or reading-history data', () => {
      loadScope().refreshSentryScope();
      const keys = mockSetTag.mock.calls.map(([key]) => String(key).toLowerCase());
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        for (const forbidden of FORBIDDEN) {
          expect(key).not.toContain(forbidden);
        }
      }
    });

    it('emits no mera_app_state field naming that data either', () => {
      loadScope().refreshSentryScope();
      const [, payload] = mockSetContext.mock.calls.find(
        ([name]) => name === 'mera_app_state',
      )!;
      for (const key of Object.keys(payload).map((k) => k.toLowerCase())) {
        for (const forbidden of FORBIDDEN) {
          expect(key).not.toContain(forbidden);
        }
      }
    });
  });
});
