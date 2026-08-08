// What we send RevenueCat about a customer — and, more importantly, what we
// must never send.
//
// `setAttributes` is write-only from the SDK's side: there is no read-back API,
// so the ONLY place the payload can be inspected is the mock's call args. That
// makes this suite the sole enforcement point for the privacy contract in
// lib/observability/app-context.ts. A future contributor who adds `setEmail` or
// forwards a persona-derived value has no other guard rail.
//
// `@/lib/observability/runtime-context` is mocked with its FULL shape, not just
// the four fields we forward. A thin mock would make the "we do NOT send
// relevance_v4 / model_state / …" assertions pass vacuously — they'd be absent
// because the mock never had them, not because the code excludes them.
// `app-context` is deliberately NOT mocked: it loads for real under jest-expo,
// so `runtime_version` / `is_embedded_launch` really are available to the code
// and really are being left out.

const mockRuntimeContext = {
  subscription_tier: 'professional',
  server_tier: 'individual',
  app_language: 'de',
  onboarding_stage: 'complete',
  processing_mode: 'cloud',
  relevance_v4: true,
  free_tier_mode: false,
  model_state: 'ready',
  network_connected: true,
  server_reachable: false,
};

jest.mock('@/lib/observability/runtime-context', () => ({
  getRuntimeContext: jest.fn(() => ({ ...mockRuntimeContext })),
}));

const load = () => {
  const rc = require('@/lib/revenuecat');
  const Purchases = require('react-native-purchases').default;
  return { rc, Purchases };
};

/** The payload of the Nth `setAttributes` call. */
const sentAttributes = (Purchases: any, n = 0): Record<string, string> =>
  Purchases.setAttributes.mock.calls[n][0];

const EXPECTED_KEYS = [
  'app_version',
  'app_build',
  'platform',
  'os_version',
  'device_tier',
  'ota_update_id',
  'ota_channel',
  'app_language',
  'onboarding_stage',
  'processing_mode',
  'server_tier',
];

describe('syncRevenueCatAttributes', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('sends exactly the eleven agreed attributes', async () => {
    const { rc, Purchases } = load();
    rc.configureRevenueCat();

    await rc.syncRevenueCatAttributes();

    expect(Purchases.setAttributes).toHaveBeenCalledTimes(1);
    const attrs = sentAttributes(Purchases);
    expect(Object.keys(attrs).sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(attrs.app_language).toBe('de');
    expect(attrs.onboarding_stage).toBe('complete');
    expect(attrs.processing_mode).toBe('cloud');
    expect(attrs.server_tier).toBe('individual');
  });

  // setAttributes only queues locally; without the sync call the values sit on
  // the device until some other SDK operation happens to flush them.
  it('flushes the queued attributes to the backend', async () => {
    const { rc, Purchases } = load();
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
    const { rc, Purchases } = load();
    rc.configureRevenueCat();

    await rc.syncRevenueCatAttributes();

    for (const value of Object.values(sentAttributes(Purchases))) {
      expect(typeof value).toBe('string');
    }
  });

  // RevenueCat's documented limits: <= 50 attributes, key <= 40, value <= 500.
  it('stays inside RevenueCat\'s attribute limits', async () => {
    const { rc, Purchases } = load();
    rc.configureRevenueCat();

    await rc.syncRevenueCatAttributes();

    const attrs = sentAttributes(Purchases);
    expect(Object.keys(attrs).length).toBeLessThanOrEqual(50);
    for (const [key, value] of Object.entries(attrs)) {
      expect(key.length).toBeLessThanOrEqual(40);
      expect(value.length).toBeLessThanOrEqual(500);
    }
  });

  it('is a no-op when the SDK is not configured', async () => {
    const { rc, Purchases } = load();

    await expect(rc.syncRevenueCatAttributes()).resolves.toBeUndefined();

    expect(Purchases.setAttributes).not.toHaveBeenCalled();
    expect(Purchases.syncAttributesAndOfferingsIfNeeded).not.toHaveBeenCalled();
  });

  // An attribute sync is telemetry. It runs on the sign-in path and on the
  // entitlement path, and neither may be broken by a vendor bridge failing.
  it('swallows a throwing setAttributes rather than propagating', async () => {
    const { rc, Purchases } = load();
    rc.configureRevenueCat();
    Purchases.setAttributes.mockImplementationOnce(() => {
      throw new Error('bridge down');
    });

    await expect(rc.syncRevenueCatAttributes()).resolves.toBeUndefined();
  });

  it('swallows a rejecting flush rather than propagating', async () => {
    const { rc, Purchases } = load();
    rc.configureRevenueCat();
    Purchases.syncAttributesAndOfferingsIfNeeded.mockRejectedValueOnce(
      new Error('offline'),
    );

    await expect(rc.syncRevenueCatAttributes()).resolves.toBeUndefined();
  });

  // The task fires on foreground, network-reconnect and every 15 minutes;
  // `syncAttributesAndOfferingsIfNeeded` is a network call.
  it('skips an unchanged payload on the next call', async () => {
    const { rc, Purchases } = load();
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
    const { rc, Purchases } = load();
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
    const { rc, Purchases } = load();
    const { getRuntimeContext } = require('@/lib/observability/runtime-context');
    rc.configureRevenueCat();

    await rc.syncRevenueCatAttributes();
    getRuntimeContext.mockReturnValue({
      ...mockRuntimeContext,
      server_tier: 'professional',
    });
    await Promise.all([
      rc.syncRevenueCatAttributes(),
      rc.syncRevenueCatAttributes(),
    ]);

    expect(Purchases.setAttributes).toHaveBeenCalledTimes(2);
    expect(sentAttributes(Purchases, 1).server_tier).toBe('professional');
  });

  // A send that failed must not be remembered as delivered.
  it('retries after a failed flush rather than skipping the unchanged payload', async () => {
    const { rc, Purchases } = load();
    rc.configureRevenueCat();
    Purchases.syncAttributesAndOfferingsIfNeeded.mockRejectedValueOnce(
      new Error('offline'),
    );

    await rc.syncRevenueCatAttributes();
    await rc.syncRevenueCatAttributes();

    expect(Purchases.setAttributes).toHaveBeenCalledTimes(2);
  });

  it('re-sends when a value actually changed', async () => {
    const { rc, Purchases } = load();
    const { getRuntimeContext } = require('@/lib/observability/runtime-context');
    rc.configureRevenueCat();

    await rc.syncRevenueCatAttributes();
    getRuntimeContext.mockReturnValueOnce({
      ...mockRuntimeContext,
      server_tier: 'starter',
    });
    await rc.syncRevenueCatAttributes();

    expect(Purchases.setAttributes).toHaveBeenCalledTimes(2);
    expect(sentAttributes(Purchases, 1).server_tier).toBe('starter');
  });
});

describe('loginRevenueCat attribute ordering', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  // The reason this ordering has its own test: `configureRevenueCat()` passes
  // no appUserID, so until `logIn` resolves the SDK is acting on an
  // SDK-minted `$RCAnonymousID:…` customer. Attributes set before that point
  // are attached to nobody and are gone after the alias — support then looks
  // up the real user id and finds a bare customer.
  it('sets attributes only after logIn has resolved', async () => {
    const { rc, Purchases } = load();
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
    const { rc, Purchases } = load();
    rc.configureRevenueCat();

    await rc.syncRevenueCatAttributes();
    await rc.loginRevenueCat('user-2');

    expect(Purchases.setAttributes).toHaveBeenCalledTimes(2);
  });

  it('still returns customerInfo when the attribute sync fails', async () => {
    const { rc, Purchases } = load();
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
    jest.clearAllMocks();
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
    const { rc, Purchases } = load();
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
    const { rc, Purchases } = load();
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

  // These are all available to the builder (runtime-context is mocked with its
  // full shape above, and app-context loads for real) and are excluded on
  // purpose — Sentry-side debugging values with no support or segmentation use
  // at a billing vendor. subscription_tier is excluded for the opposite reason:
  // it is RevenueCat's own view, so echoing it back tells the dashboard nothing
  // that server_tier doesn't tell it better.
  it('omits the available-but-deliberately-excluded values', async () => {
    const { rc, Purchases } = load();
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
  });
});
