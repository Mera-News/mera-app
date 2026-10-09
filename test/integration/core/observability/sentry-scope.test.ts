// The real runtime-context and the real five stores run; only Sentry and the two expo build
// modules (native edges) are replaced. Assertions are made against the tag keys that would
// actually ship, so the privacy guard at the bottom cannot be vacuous.

const mockSetUser = jest.fn();
const mockSetTag = jest.fn();
const mockSetContext = jest.fn();

jest.mock('@sentry/react-native', () => ({
  init: jest.fn(),
  setUser: mockSetUser,
  setTag: mockSetTag,
  setContext: mockSetContext,
  feedbackIntegration: jest.fn(() => ({})),
  breadcrumbsIntegration: jest.fn(() => ({})),
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

type ScopeModule = typeof import('@/lib/observability/sentry-scope');

interface Loaded {
  scope: ScopeModule;
  stores: {
    language: typeof import('@/lib/stores/app-language-store').useAppLanguageStore;
    subscription: typeof import('@/lib/stores/subscription-store').useSubscriptionStore;
    mera: typeof import('@/lib/stores/mera-protocol-store').useMeraProtocolStore;
    network: typeof import('@/lib/stores/network-store').useNetworkStore;
    user: typeof import('@/lib/stores/user-store').useUserStore;
  };
}

// SENTRY_ENABLED is computed at sentry-init module load from __DEV__, and sentry-scope keeps
// the last emitted payload in module state, so the whole graph (scope and the five stores it
// reads) is rebuilt per case in ONE registry: the stores a test drives are the ones the scope reads.
function load(enabled: boolean): Loaded {
  (global as { __DEV__?: boolean }).__DEV__ = !enabled;
  process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://test@sentry.io/1';
  delete process.env.EXPO_PUBLIC_SENTRY_IN_DEV;
  jest.resetModules();
  const loaded: Loaded = {
    scope: require('@/lib/observability/sentry-scope'),
    stores: {
      language: require('@/lib/stores/app-language-store').useAppLanguageStore,
      subscription: require('@/lib/stores/subscription-store').useSubscriptionStore,
      mera: require('@/lib/stores/mera-protocol-store').useMeraProtocolStore,
      network: require('@/lib/stores/network-store').useNetworkStore,
      user: require('@/lib/stores/user-store').useUserStore,
    },
  };
  const { stores } = loaded;
  stores.language.setState({ appLanguage: 'en' });
  stores.subscription.setState({ tier: 'pro', serverTier: 'pro' } as never);
  stores.mera.setState({
    processingMode: 'CLOUD',
    relevanceV4: true,
    modelState: 'not_downloaded',
  } as never);
  stores.network.setState({ isConnected: true, serverReachable: false });
  stores.user.setState({ userPersona: { onboardingStage: 'COMPLETE' } } as never);
  // Loading the graph runs lib/sentry-init.ts, which sets the STATIC build tags as a module
  // side effect. Clear here so each case asserts only on what sentry-scope itself emitted.
  jest.clearAllMocks();
  return loaded;
}

const ENV_AT_LOAD = { ...process.env };

afterEach(() => {
  (global as { __DEV__?: boolean }).__DEV__ = true;
  for (const key of Object.keys(process.env)) {
    if (!(key in ENV_AT_LOAD)) delete process.env[key];
  }
  Object.assign(process.env, ENV_AT_LOAD);
});

describe('sentry-scope', () => {
  describe('applySentryUser', () => {
    it('sets user.id only', () => {
      load(true).scope.applySentryUser('68f0c0ffee0000000000beef');
      expect(mockSetUser).toHaveBeenCalledWith({
        id: '68f0c0ffee0000000000beef',
      });
    });

    it('never sets email, username or ip_address', () => {
      load(true).scope.applySentryUser('u1');
      const [payload] = mockSetUser.mock.calls[0];
      expect(Object.keys(payload)).toEqual(['id']);
    });

    it('clears the user with null on logout', () => {
      load(true).scope.applySentryUser(null);
      expect(mockSetUser).toHaveBeenCalledWith(null);
    });

    it('is a no-op when Sentry is disabled (dev without the opt-in flag)', () => {
      load(false).scope.applySentryUser('u1');
      expect(mockSetUser).not.toHaveBeenCalled();
    });
  });

  describe('refreshSentryScope', () => {
    it('emits one tag per runtime-context field', () => {
      load(true).scope.refreshSentryScope();
      const emitted = Object.fromEntries(mockSetTag.mock.calls);
      expect(emitted).toEqual({
        subscription_tier: 'pro',
        server_tier: 'pro',
        app_language: 'en',
        onboarding_stage: 'COMPLETE',
        processing_mode: 'CLOUD',
        // The EFFECTIVE value (harness defaults, v4 OFF), not the store's stale
        // `relevanceV4: true` above: the removed setting must not be reported.
        relevance_v4: 'false',
        model_state: 'not_downloaded',
        network_connected: 'true',
        server_reachable: 'false',
      });
    });

    it('coerces boolean tag values to strings', () => {
      load(true).scope.refreshSentryScope();
      expect(mockSetTag).toHaveBeenCalled();
      for (const [, value] of mockSetTag.mock.calls) {
        expect(typeof value).toBe('string');
      }
    });

    it('merges the static build facts into the mera_app_state context', () => {
      load(true).scope.refreshSentryScope();
      expect(mockSetContext).toHaveBeenCalledWith(
        'mera_app_state',
        expect.objectContaining({
          ota_update_id: 'update-abc',
          subscription_tier: 'pro',
        }),
      );
    });

    it('skips a repeat emission when nothing changed', () => {
      // Store subscriptions fire on every download-progress tick; re-crossing the native
      // bridge with identical values ~10x per tick is the cost this guard exists to avoid.
      const { scope } = load(true);
      scope.refreshSentryScope();
      const firstCallCount = mockSetTag.mock.calls.length;
      expect(firstCallCount).toBeGreaterThan(0);
      scope.refreshSentryScope();
      expect(mockSetTag.mock.calls.length).toBe(firstCallCount);
    });

    it('is a no-op when Sentry is disabled', () => {
      load(false).scope.refreshSentryScope();
      expect(mockSetTag).not.toHaveBeenCalled();
    });
  });

  describe('startSentryScopeSync', () => {
    it('emits immediately and re-emits on a change in each of the five stores', () => {
      const { scope, stores } = load(true);
      const stop = scope.startSentryScopeSync();
      expect(mockSetTag).toHaveBeenCalledWith('subscription_tier', 'pro');

      const changes: [() => void, string, string][] = [
        [() => stores.language.setState({ appLanguage: 'de' }), 'app_language', 'de'],
        [() => stores.subscription.setState({ tier: 'free' } as never), 'subscription_tier', 'free'],
        [() => stores.mera.setState({ modelState: 'ready' } as never), 'model_state', 'ready'],
        [() => stores.network.setState({ serverReachable: true }), 'server_reachable', 'true'],
        [
          () => stores.user.setState({ userPersona: { onboardingStage: 'WELCOME' } } as never),
          'onboarding_stage',
          'WELCOME',
        ],
      ];
      for (const [change, tag, value] of changes) {
        mockSetTag.mockClear();
        change();
        expect(mockSetTag).toHaveBeenCalledWith(tag, value);
      }
      stop();
    });

    it('tears every subscription down', () => {
      const { scope, stores } = load(true);
      const stop = scope.startSentryScopeSync();
      stop();
      mockSetTag.mockClear();

      stores.language.setState({ appLanguage: 'fr' });
      stores.subscription.setState({ tier: 'free' } as never);
      stores.mera.setState({ modelState: 'ready' } as never);
      stores.network.setState({ isConnected: false });
      stores.user.setState({ userPersona: { onboardingStage: 'WELCOME' } } as never);

      expect(mockSetTag).not.toHaveBeenCalled();
    });

    it('returns a harmless teardown when Sentry is disabled', () => {
      const { scope, stores } = load(false);
      const stop = scope.startSentryScopeSync();
      expect(() => stop()).not.toThrow();
      stores.language.setState({ appLanguage: 'fr' });
      expect(mockSetTag).not.toHaveBeenCalled();
    });
  });

  // The product invariant: no collection links a user to a topic, and the privacy policy
  // states we do not collect article-level behaviour. A tag is a collection. This asserts on
  // the REAL emitted key set, so a future field added to runtime-context.ts trips it rather
  // than sliding through.
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
      // NB: 'ip' is deliberately absent, it is a substring of "subscription".
      // ip_address is a `user` field, and beforeSend's allowlist covers it.
    ];

    it('emits no tag key naming persona, topic, location or reading-history data', () => {
      load(true).scope.refreshSentryScope();
      const keys = mockSetTag.mock.calls.map(([key]) => String(key).toLowerCase());
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        for (const forbidden of FORBIDDEN) {
          expect(key).not.toContain(forbidden);
        }
      }
    });

    it('emits no mera_app_state field naming that data either', () => {
      load(true).scope.refreshSentryScope();
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
