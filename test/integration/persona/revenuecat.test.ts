/* eslint-disable @typescript-eslint/no-require-imports */
// The RevenueCat wrapper against the setup's SDK mock: configure/login/logout, entitlement-to-tier mapping,
// null-safe reads, the subscription-row probe, and the subscriber-attribute contract (what we send, and what
// we must never send). Module state (`configured`, the last attribute signature) has no reset export, so each
// test loads a fresh module registry, the same way the cases always did. The runtime context the attributes
// are built from is REAL: its stores are seeded from the same fresh registry.

// REVENUECAT_API_KEY is inlined from the environment at transform time (a test key), so
// isRevenueCatEnabled() is true here.

const customerInfo = (active: Record<string, unknown> = {}) => ({
  entitlements: { active },
});

const load = () => {
  const rc = require('@/lib/revenuecat');
  const Purchases = require('react-native-purchases').default;
  return { rc, Purchases };
};

/** `load()`, with the stores `getRuntimeContext` reads seeded from the same registry. */
const loadWithContext = () => {
  const loaded = load();
  const { useSubscriptionStore } = require('@/lib/stores/subscription-store');
  const { useAppLanguageStore } = require('@/lib/stores/app-language-store');
  const { useMeraProtocolStore } = require('@/lib/stores/mera-protocol-store');
  const { useUserStore } = require('@/lib/stores/user-store');
  const { useNetworkStore } = require('@/lib/stores/network-store');
  useSubscriptionStore.setState({ tier: 'professional', serverTier: 'individual' });
  useAppLanguageStore.setState({ appLanguage: 'de' });
  useMeraProtocolStore.setState({ processingMode: 'CLOUD', modelState: 'ready' });
  useUserStore.setState({ userPersona: { onboardingStage: 'FINISHED' } });
  useNetworkStore.setState({ isConnected: true, serverReachable: false });
  return { ...loaded, useSubscriptionStore };
};

describe('revenuecat', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  // The SDK is configured with no appUserID, so every cold start runs
  // anonymously until `loginRevenueCat` aliases the customer. Observed on a real
  // device: `👤 No initial App User ID`, then
  // `GET /v1/subscribers/$RCAnonymousID%3A72f363cf…`. That payload's empty
  // entitlements describe nobody and must never be read as a denial.
  describe('isAnonymousCustomerInfo', () => {
    it('is true for an SDK-minted anonymous customer', () => {
      const { rc } = load();
      expect(
        rc.isAnonymousCustomerInfo({
          originalAppUserId: '$RCAnonymousID:72f363cf86514c138a873e067020a196',
        }),
      ).toBe(true);
    });

    it('is false once logIn has attached our own user id', () => {
      const { rc } = load();
      expect(
        rc.isAnonymousCustomerInfo({ originalAppUserId: '6a73cbcc19632e639560a9cb' }),
      ).toBe(false);
    });

    it('is false for null/undefined/missing ids rather than throwing', () => {
      const { rc } = load();
      expect(rc.isAnonymousCustomerInfo(null)).toBe(false);
      expect(rc.isAnonymousCustomerInfo(undefined)).toBe(false);
      expect(rc.isAnonymousCustomerInfo({})).toBe(false);
    });
  });

  describe('getActiveTier', () => {
    it('returns professional when the professional entitlement is active', () => {
      const { rc } = load();
      expect(rc.getActiveTier(customerInfo({ professional: {} }))).toBe(
        'professional',
      );
    });

    it('prefers professional over individual', () => {
      const { rc } = load();
      expect(
        rc.getActiveTier(customerInfo({ professional: {}, individual: {} })),
      ).toBe('professional');
    });

    it('returns individual when only individual is active', () => {
      const { rc } = load();
      expect(rc.getActiveTier(customerInfo({ individual: {} }))).toBe(
        'individual',
      );
    });

    it('returns starter when only the starter entitlement is active', () => {
      const { rc } = load();
      expect(
        rc.getActiveTier(customerInfo({ 'mera-news-starter-plan': {} })),
      ).toBe('starter');
    });

    it('prefers professional over starter when both are active', () => {
      const { rc } = load();
      expect(
        rc.getActiveTier(
          customerInfo({
            professional: {},
            'mera-news-starter-plan': {},
          }),
        ),
      ).toBe('professional');
    });

    it('returns null when no entitlements are active', () => {
      const { rc } = load();
      expect(rc.getActiveTier(customerInfo())).toBeNull();
      expect(rc.getActiveTier(null)).toBeNull();
    });
  });

  describe('configureRevenueCat', () => {
    it('configures the SDK and marks it configured', () => {
      const { rc, Purchases } = load();
      expect(rc.isRevenueCatConfigured()).toBe(false);
      rc.configureRevenueCat();
      expect(Purchases.configure).toHaveBeenCalledTimes(1);
      expect(rc.isRevenueCatConfigured()).toBe(true);
    });

    it('is a no-op when already configured', () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      rc.configureRevenueCat();
      expect(Purchases.configure).toHaveBeenCalledTimes(1);
    });
  });

  describe('loginRevenueCat', () => {
    it('returns null when not configured', async () => {
      const { rc, Purchases } = load();
      const result = await rc.loginRevenueCat('user-1');
      expect(result).toBeNull();
      expect(Purchases.logIn).not.toHaveBeenCalled();
    });

    it('returns customerInfo on success', async () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      Purchases.logIn.mockResolvedValueOnce({
        customerInfo: customerInfo({ individual: {} }),
        created: false,
      });
      const result = await rc.loginRevenueCat('user-1');
      expect(Purchases.logIn).toHaveBeenCalledWith('user-1');
      expect(result).toEqual(customerInfo({ individual: {} }));
    });

    it('returns null on error', async () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      Purchases.logIn.mockRejectedValueOnce(new Error('boom'));
      expect(await rc.loginRevenueCat('user-1')).toBeNull();
    });
  });

  describe('logoutRevenueCat', () => {
    it('does nothing when not configured', async () => {
      const { rc, Purchases } = load();
      await rc.logoutRevenueCat();
      expect(Purchases.logOut).not.toHaveBeenCalled();
    });

    it('calls logOut when configured', async () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      await rc.logoutRevenueCat();
      expect(Purchases.logOut).toHaveBeenCalledTimes(1);
    });

    it('swallows logOut errors', async () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      Purchases.logOut.mockRejectedValueOnce(new Error('anonymous'));
      await expect(rc.logoutRevenueCat()).resolves.toBeUndefined();
    });

    // A logout calls this twice — clearAuthStorage() and wipeAllLocalUserData()
    // each reset RevenueCat. The second call must be a silent no-op rather than
    // a thrown-and-caught "current user is anonymous".
    it('is a no-op when the customer is already anonymous', async () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      Purchases.isAnonymous.mockResolvedValueOnce(true);
      await rc.logoutRevenueCat();
      expect(Purchases.logOut).not.toHaveBeenCalled();
    });

    it('stays resolved when the anonymity check itself fails', async () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      Purchases.isAnonymous.mockRejectedValueOnce(new Error('bridge down'));
      await expect(rc.logoutRevenueCat()).resolves.toBeUndefined();
    });
  });

  describe('getCustomerInfoSafe', () => {
    it('returns null when not configured', async () => {
      const { rc } = load();
      expect(await rc.getCustomerInfoSafe()).toBeNull();
    });

    it('returns customer info when configured', async () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      Purchases.getCustomerInfo.mockResolvedValueOnce(
        customerInfo({ professional: {} }),
      );
      expect(await rc.getCustomerInfoSafe()).toEqual(
        customerInfo({ professional: {} }),
      );
    });

    it('returns null on error', async () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      Purchases.getCustomerInfo.mockRejectedValueOnce(new Error('net'));
      expect(await rc.getCustomerInfoSafe()).toBeNull();
    });
  });

  describe('getOfferingSafe', () => {
    it('returns null when not configured', async () => {
      const { rc } = load();
      expect(await rc.getOfferingSafe()).toBeNull();
    });

    it('returns the offering matching the default identifier', async () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      const offering = { identifier: rc.OFFERING_SUBSCRIPTION };
      Purchases.getOfferings.mockResolvedValueOnce({
        current: null,
        all: { [rc.OFFERING_SUBSCRIPTION]: offering },
      });
      expect(await rc.getOfferingSafe()).toBe(offering);
    });

    it('looks up an explicit identifier', async () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      const offering = { identifier: 'other' };
      Purchases.getOfferings.mockResolvedValueOnce({
        current: null,
        all: { other: offering },
      });
      expect(await rc.getOfferingSafe('other')).toBe(offering);
    });

    it('returns null when the offering is absent', async () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      Purchases.getOfferings.mockResolvedValueOnce({ current: null, all: {} });
      expect(await rc.getOfferingSafe()).toBeNull();
    });

    it('returns null on error', async () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      Purchases.getOfferings.mockRejectedValueOnce(new Error('net'));
      expect(await rc.getOfferingSafe()).toBeNull();
    });
  });

  describe('addCustomerInfoUpdateListener', () => {
    it('returns a no-op unsubscribe when not configured', () => {
      const { rc, Purchases } = load();
      const remove = rc.addCustomerInfoUpdateListener(jest.fn());
      expect(Purchases.addCustomerInfoUpdateListener).not.toHaveBeenCalled();
      expect(() => remove()).not.toThrow();
    });

    it('registers and unregisters the listener when configured', () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      const cb = jest.fn();
      const remove = rc.addCustomerInfoUpdateListener(cb);
      expect(Purchases.addCustomerInfoUpdateListener).toHaveBeenCalledWith(cb);
      remove();
      expect(Purchases.removeCustomerInfoUpdateListener).toHaveBeenCalledWith(cb);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Probe helper for the deferred-plan-change investigation: `react-native-purchases`' CustomerInfo exposes no
// field naming a future product, so describeSubscriptions() is what gets logged to answer what the store
// records client-side while a deferred change is pending.

const sub = (overrides: Record<string, unknown> = {}) => ({
    productIdentifier: 'mera_news_individual_monthly',
    purchaseDate: '2026-07-01T00:00:00Z',
    originalPurchaseDate: '2026-06-01T00:00:00Z',
    expiresDate: '2026-08-01T00:00:00Z',
    store: 'APP_STORE',
    unsubscribeDetectedAt: null,
    isSandbox: false,
    billingIssuesDetectedAt: null,
    gracePeriodExpiresDate: null,
    ownershipType: 'PURCHASED',
    periodType: 'NORMAL',
    refundedAt: null,
    storeTransactionId: 'txn-1',
    isActive: true,
    willRenew: true,
    ...overrides,
});

describe('describeSubscriptions', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    it('returns an empty list for null/undefined customer info', () => {
        const { rc } = load();
        expect(rc.describeSubscriptions(null)).toEqual([]);
        expect(rc.describeSubscriptions(undefined)).toEqual([]);
    });

    it('returns an empty list when the customer has no subscriptions', () => {
        const { rc } = load();
        expect(
            rc.describeSubscriptions({ subscriptionsByProductIdentifier: {} }),
        ).toEqual([]);
    });

    it('flattens every subscription row to the fields that would reveal a pending plan change', () => {
        const { rc } = load();
        const rows = rc.describeSubscriptions({
            subscriptionsByProductIdentifier: {
                mera_news_individual_monthly: sub(),
                // If the App Store records the deferred Professional purchase at
                // all, it would show up as a second, not-yet-active row.
                mera_news_professional_monthly: sub({
                    productIdentifier: 'mera_news_professional_monthly',
                    isActive: false,
                    willRenew: true,
                    purchaseDate: '2026-08-01T00:00:00Z',
                    expiresDate: null,
                }),
            },
        });

        expect(rows).toEqual([
            {
                productIdentifier: 'mera_news_individual_monthly',
                isActive: true,
                willRenew: true,
                periodType: 'NORMAL',
                store: 'APP_STORE',
                purchaseDate: '2026-07-01T00:00:00Z',
                expiresDate: '2026-08-01T00:00:00Z',
                unsubscribeDetectedAt: null,
            },
            {
                productIdentifier: 'mera_news_professional_monthly',
                isActive: false,
                willRenew: true,
                periodType: 'NORMAL',
                store: 'APP_STORE',
                purchaseDate: '2026-08-01T00:00:00Z',
                expiresDate: null,
                unsubscribeDetectedAt: null,
            },
        ]);
    });

    it('keys each row by the map key, not the nested productIdentifier', () => {
        const { rc } = load();
        const rows = rc.describeSubscriptions({
            subscriptionsByProductIdentifier: {
                'mera_news_subscriptions:mera-news-individual-monthly': sub(),
            },
        });
        expect(rows[0].productIdentifier).toBe(
            'mera_news_subscriptions:mera-news-individual-monthly',
        );
    });
});

// ---------------------------------------------------------------------------------------------
// What we send RevenueCat about a customer, and what we must never send. `setAttributes` is write-only from
// the SDK's side, so the only place the payload can be inspected is the mock's call args: this is the sole
// enforcement point for the privacy contract in lib/observability/app-context.ts.

/** The payload of the Nth `setAttributes` call. */
const sentAttributes = (Purchases: any, n = 0): Record<string, string | null> =>
  Purchases.setAttributes.mock.calls[n][0];

const KEPT_KEYS = [
  'app_version',
  'app_build',
  'ota_update_id',
  'platform',
  'os_version',
  'server_tier',
];

// Sent as null so RevenueCat deletes what an earlier build stored.
const RETIRED_KEYS = [
  'device_tier',
  'ota_channel',
  'app_language',
  'onboarding_stage',
  'processing_mode',
];

const EXPECTED_KEYS = [...KEPT_KEYS, ...RETIRED_KEYS];

/** The attributes that carry a value, i.e. without the null deletions. */
const valued = (attrs: Record<string, string | null>) =>
  Object.entries(attrs).filter(([, v]) => v !== null) as [string, string][];

describe('syncRevenueCatAttributes', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('sends exactly the six attributes billing support needs', async () => {
  const { rc, Purchases } = loadWithContext();
    rc.configureRevenueCat();

    await rc.syncRevenueCatAttributes();

    expect(Purchases.setAttributes).toHaveBeenCalledTimes(1);
    const attrs = sentAttributes(Purchases);
    expect(Object.keys(attrs).sort()).toEqual([...EXPECTED_KEYS].sort());
    for (const key of RETIRED_KEYS) expect(attrs[key]).toBeNull();
    for (const key of KEPT_KEYS) expect(typeof attrs[key]).toBe('string');
    expect(attrs.server_tier).toBe('individual');
  });

  // setAttributes only queues locally; without the sync call the values sit on
  // the device until some other SDK operation happens to flush them.
  it('flushes the queued attributes to the backend', async () => {
  const { rc, Purchases } = loadWithContext();
    rc.configureRevenueCat();

    await rc.syncRevenueCatAttributes();

    expect(Purchases.syncAttributesAndOfferingsIfNeeded).toHaveBeenCalledTimes(1);
    expect(
      Purchases.setAttributes.mock.invocationCallOrder[0],
    ).toBeLessThan(
      Purchases.syncAttributesAndOfferingsIfNeeded.mock.invocationCallOrder[0],
    );
  });

  // RevenueCat requires string values; a boolean or number would be coerced by
  // the bridge in a way we don't control.
  it('coerces every value to a string', async () => {
  const { rc, Purchases } = loadWithContext();
    rc.configureRevenueCat();

    await rc.syncRevenueCatAttributes();

    for (const [, value] of valued(sentAttributes(Purchases))) {
      expect(typeof value).toBe('string');
    }
  });

  // RevenueCat's documented limits: <= 50 attributes, key <= 40, value <= 500.
  it('stays inside RevenueCat\'s attribute limits', async () => {
  const { rc, Purchases } = loadWithContext();
    rc.configureRevenueCat();

    await rc.syncRevenueCatAttributes();

    const attrs = sentAttributes(Purchases);
    expect(Object.keys(attrs).length).toBeLessThanOrEqual(50);
    for (const [key, value] of valued(attrs)) {
      expect(key.length).toBeLessThanOrEqual(40);
      expect(value.length).toBeLessThanOrEqual(500);
    }
  });

  it('is a no-op when the SDK is not configured', async () => {
    const { rc, Purchases } = loadWithContext();

    await expect(rc.syncRevenueCatAttributes()).resolves.toBeUndefined();

    expect(Purchases.setAttributes).not.toHaveBeenCalled();
    expect(Purchases.syncAttributesAndOfferingsIfNeeded).not.toHaveBeenCalled();
  });

  // An attribute sync is telemetry. It runs on the sign-in path and on the
  // entitlement path, and neither may be broken by a vendor bridge failing.
  it('swallows a throwing setAttributes rather than propagating', async () => {
  const { rc, Purchases } = loadWithContext();
    rc.configureRevenueCat();
    Purchases.setAttributes.mockImplementationOnce(() => {
      throw new Error('bridge down');
    });

    await expect(rc.syncRevenueCatAttributes()).resolves.toBeUndefined();
  });

  it('swallows a rejecting flush rather than propagating', async () => {
  const { rc, Purchases } = loadWithContext();
    rc.configureRevenueCat();
    Purchases.syncAttributesAndOfferingsIfNeeded.mockRejectedValueOnce(
      new Error('offline'),
    );

    await expect(rc.syncRevenueCatAttributes()).resolves.toBeUndefined();
  });

  // The task fires on foreground, network-reconnect and every 15 minutes;
  // `syncAttributesAndOfferingsIfNeeded` is a network call.
  it('skips an unchanged payload on the next call', async () => {
  const { rc, Purchases } = loadWithContext();
    rc.configureRevenueCat();

    await rc.syncRevenueCatAttributes();
    await rc.syncRevenueCatAttributes();

    expect(Purchases.setAttributes).toHaveBeenCalledTimes(1);
  });

  // The shape entitlement-sync-task actually produces: syncEntitlement's
  // success path fires this WITHOUT awaiting, then the task calls it again.
  // The second call starts while the first is still suspended on the flush, so
  // the skip only works if the signature is recorded before the await.
  it('coalesces two concurrent calls into one send', async () => {
  const { rc, Purchases } = loadWithContext();
    rc.configureRevenueCat();

    await Promise.all([
      rc.syncRevenueCatAttributes(),
      rc.syncRevenueCatAttributes(),
    ]);

    expect(Purchases.setAttributes).toHaveBeenCalledTimes(1);
  });

  // Same race, on the path that matters — a value just changed, which is the
  // only reason the entitlement seam calls this at all.
  it('coalesces concurrent calls even when the payload just changed', async () => {
    const { rc, Purchases, useSubscriptionStore } = loadWithContext();
    rc.configureRevenueCat();

    await rc.syncRevenueCatAttributes();
    useSubscriptionStore.setState({ serverTier: 'professional' });
    await Promise.all([
      rc.syncRevenueCatAttributes(),
      rc.syncRevenueCatAttributes(),
    ]);

    expect(Purchases.setAttributes).toHaveBeenCalledTimes(2);
    expect(sentAttributes(Purchases, 1).server_tier).toBe('professional');
  });

  // A send that failed must not be remembered as delivered.
  it('retries after a failed flush rather than skipping the unchanged payload', async () => {
  const { rc, Purchases } = loadWithContext();
    rc.configureRevenueCat();
    Purchases.syncAttributesAndOfferingsIfNeeded.mockRejectedValueOnce(
      new Error('offline'),
    );

    await rc.syncRevenueCatAttributes();
    await rc.syncRevenueCatAttributes();

    expect(Purchases.setAttributes).toHaveBeenCalledTimes(2);
  });

  // MERA-APP-8H: Play's SERVICE_UNAVAILABLE arrives as STORE_PROBLEM_ERROR ("2"); the next tick retries.
  it.each([['store problem', '2'], ['network', '10']])(
    'warns instead of capturing a %s error, and still retries',
    async (_label, code) => {
      const { rc, Purchases } = loadWithContext();
      const logger = require('@/lib/logger').default;
      const capture = jest.spyOn(logger, 'captureException').mockReturnValue('');
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      rc.configureRevenueCat();
      Purchases.syncAttributesAndOfferingsIfNeeded.mockRejectedValueOnce(
        Object.assign(new Error('SERVICE_UNAVAILABLE'), { code }),
      );

      await rc.syncRevenueCatAttributes();
      await rc.syncRevenueCatAttributes();

      expect(capture).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(Purchases.setAttributes).toHaveBeenCalledTimes(2);
    },
  );

  it('still captures any other sync error', async () => {
    const { rc, Purchases } = loadWithContext();
    const logger = require('@/lib/logger').default;
    const capture = jest.spyOn(logger, 'captureException').mockReturnValue('');
    rc.configureRevenueCat();
    Purchases.syncAttributesAndOfferingsIfNeeded.mockRejectedValueOnce(
      Object.assign(new Error('bad config'), { code: '23' }),
    );

    await rc.syncRevenueCatAttributes();

    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('re-sends when a value actually changed', async () => {
    const { rc, Purchases, useSubscriptionStore } = loadWithContext();
    rc.configureRevenueCat();

    await rc.syncRevenueCatAttributes();
    useSubscriptionStore.setState({ serverTier: 'starter' });
    await rc.syncRevenueCatAttributes();

    expect(Purchases.setAttributes).toHaveBeenCalledTimes(2);
    expect(sentAttributes(Purchases, 1).server_tier).toBe('starter');
  });
});

describe('loginRevenueCat attribute ordering', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  // The reason this ordering has its own test: `configureRevenueCat()` passes
  // no appUserID, so until `logIn` resolves the SDK is acting on an
  // SDK-minted `$RCAnonymousID:…` customer. Attributes set before that point
  // are attached to nobody and are gone after the alias — support then looks
  // up the real user id and finds a bare customer.
  it('sets attributes only after logIn has resolved', async () => {
  const { rc, Purchases } = loadWithContext();
    rc.configureRevenueCat();
    Purchases.logIn.mockImplementationOnce(async () => {
      // Asserting *inside* the mock is what actually pins the ordering; the
      // invocationCallOrder check below would also pass for a call made in the
      // same tick before logIn's promise settled.
      expect(Purchases.setAttributes).not.toHaveBeenCalled();
      await Promise.resolve();
      return { customerInfo: { entitlements: { active: {} } }, created: false };
    });

    const info = await rc.loginRevenueCat('user-1');

    // A throw from the in-mock expect would be caught by loginRevenueCat and
    // surface as null, so this guards the guard.
    expect(info).not.toBeNull();
    expect(Purchases.setAttributes).toHaveBeenCalledTimes(1);
    expect(
      Purchases.setAttributes.mock.invocationCallOrder[0],
    ).toBeGreaterThan(Purchases.logIn.mock.invocationCallOrder[0]);
  });

  // Attributes are stored per app_user_id. Two users signing in on one device
  // can produce a byte-identical payload, and the unchanged-payload skip would
  // then leave the second one with nothing.
  it('forces a re-send on login even when the payload is unchanged', async () => {
  const { rc, Purchases } = loadWithContext();
    rc.configureRevenueCat();

    await rc.syncRevenueCatAttributes();
    await rc.loginRevenueCat('user-2');

    expect(Purchases.setAttributes).toHaveBeenCalledTimes(2);
  });

  it('still returns customerInfo when the attribute sync fails', async () => {
  const { rc, Purchases } = loadWithContext();
    rc.configureRevenueCat();
    Purchases.setAttributes.mockImplementationOnce(() => {
      throw new Error('bridge down');
    });

    await expect(rc.loginRevenueCat('user-1')).resolves.not.toBeNull();
  });
});

// The privacy guard. Everything above describes what we DO send; this describes
// the boundary that makes the feature acceptable at all.
describe('subscriber-attribute privacy contract', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  // Identity, contact and advertising surfaces. `$`-prefixed keys are
  // RevenueCat's reserved namespace — $email, $displayName, $phoneNumber,
  // $idfa, $idfv, $gpsAdId, $ip and the whole attribution family live there,
  // and the app's iOS privacy manifest declares NSPrivacyTracking = false.
  const FORBIDDEN_KEY_PATTERNS = [
    /^\$/,
    /email/i,
    /phone/i,
    /name/i,
    /idfa|idfv|gps_?ad|advertis/i,
    /push|token/i,
    /ip_?addr/i,
    // The product invariant: no collection links a user to a topic.
    /persona|topic|interest|fact/i,
    /location|country|city|latitude|longitude|geo/i,
    /article|read|history|click|impression/i,
  ];

  it('never sends an identifying, advertising or persona-derived key', async () => {
  const { rc, Purchases } = loadWithContext();
    rc.configureRevenueCat();

    await rc.syncRevenueCatAttributes();

    for (const key of Object.keys(sentAttributes(Purchases))) {
      for (const pattern of FORBIDDEN_KEY_PATTERNS) {
        expect(key).not.toMatch(pattern);
      }
    }
  });

  // Belt and braces: the SDK methods that would leak PII regardless of the
  // attribute map. These are mocked in jest.setup.js only for the ones we DO
  // call, so an accidental `Purchases.setEmail(...)` would throw — but a
  // future contributor may add the mock at the same time as the call, and this
  // states the intent in the suite that owns it.
  it('never calls the PII-carrying SDK entry points', async () => {
  const { rc, Purchases } = loadWithContext();
    rc.configureRevenueCat();

    await rc.syncRevenueCatAttributes();
    await rc.loginRevenueCat('user-1');

    for (const method of [
      'setEmail',
      'setDisplayName',
      'setPhoneNumber',
      'setPushToken',
      'collectDeviceIdentifiers',
      'setAd',
      'setCampaign',
      'setAttributionData',
    ]) {
      expect(Purchases[method]).toBeUndefined();
    }
  });

  // These are all available to the builder (the runtime context is real and
  // seeded with all of them, and app-context loads for real) and are excluded on
  // purpose — Sentry-side debugging values with no support or segmentation use
  // at a billing vendor. subscription_tier is excluded for the opposite reason:
  // it is RevenueCat's own view, so echoing it back tells the dashboard nothing
  // that server_tier doesn't tell it better.
  it('omits the available-but-deliberately-excluded values', async () => {
  const { rc, Purchases } = loadWithContext();
    rc.configureRevenueCat();

    await rc.syncRevenueCatAttributes();

    const attrs = sentAttributes(Purchases);
    for (const key of [
      'subscription_tier',
      'relevance_v4',
      'free_tier_mode',
      'model_state',
      'network_connected',
      'server_reachable',
      'runtime_version',
      'is_embedded_launch',
    ]) {
      expect(attrs).not.toHaveProperty(key);
    }
    // And no value smuggles the excluded tier in under another key.
    expect(Object.values(attrs)).not.toContain('professional');
    // A retired key is only ever a deletion, never a value.
    for (const key of RETIRED_KEYS) expect(attrs[key]).toBeNull();
  });
});

describe('restoreRevenueCatPurchases', () => {
  beforeEach(() => jest.resetModules());

  it('returns the CustomerInfo the store restore answers with', async () => {
    const { rc, Purchases } = load();
    const info = customerInfo({ 'mera-news-starter-plan': { isActive: true } });
    Purchases.restorePurchases.mockResolvedValueOnce(info);
    await expect(rc.restoreRevenueCatPurchases()).resolves.toBe(info);
  });

  it('throws when the store cannot be reached', async () => {
    const { rc, Purchases } = load();
    Purchases.restorePurchases.mockRejectedValueOnce(new Error('offline'));
    await expect(rc.restoreRevenueCatPurchases()).rejects.toThrow('offline');
  });
});
