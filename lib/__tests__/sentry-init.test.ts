// sentry-init runs Sentry.init at module-load time when __DEV__ is false.
// We need to control __DEV__ and capture the exact init call arguments.

const mockSentryInit = jest.fn();
const mockSetContext = jest.fn();
const mockSetTag = jest.fn();
const mockFeedbackIntegration = jest.fn(() => ({ name: 'FeedbackIntegration' }));

jest.mock('@sentry/react-native', () => ({
  init: mockSentryInit,
  setContext: mockSetContext,
  setTag: mockSetTag,
  feedbackIntegration: mockFeedbackIntegration,
  captureException: jest.fn(),
}));

// sentry-init now reads lib/observability/app-context.ts for the static build
// tags. Neither of these native modules is mocked globally (jest.setup.js covers
// expo-device only), so they're mocked here rather than there — this suite
// shadows the global Sentry mock anyway, so it is already self-contained.
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

describe('sentry-init (prod path: __DEV__ = false)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    // Simulate production: __DEV__ = false
    (global as any).__DEV__ = false;
  });

  afterEach(() => {
    // Restore jest config default
    (global as any).__DEV__ = true;
  });

  it('calls Sentry.init with sendDefaultPii: false', () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://test@sentry.io/123';
    process.env.EXPO_PUBLIC_AUTH_ENDPOINT = 'https://auth.test';
    process.env.EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT = 'https://api.test';
    process.env.EXPO_PUBLIC_INFERENCE_ENDPOINT = 'https://infer.test';
    require('../sentry-init');
    expect(mockSentryInit).toHaveBeenCalledWith(
      expect.objectContaining({ sendDefaultPii: false }),
    );
  });

  it('calls Sentry.init with the DSN from env', () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://key@sentry.io/456';
    require('../sentry-init');
    expect(mockSentryInit).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: 'https://key@sentry.io/456' }),
    );
  });

  it('includes the feedback integration in the integrations array', () => {
    require('../sentry-init');
    const [config] = mockSentryInit.mock.calls[0];
    expect(Array.isArray(config.integrations)).toBe(true);
    expect(config.integrations.length).toBeGreaterThan(0);
  });

  it('sets runtime_endpoints context with auth, graphql, inference values', () => {
    process.env.EXPO_PUBLIC_AUTH_ENDPOINT = 'https://auth.example';
    process.env.EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT = 'https://gql.example';
    process.env.EXPO_PUBLIC_INFERENCE_ENDPOINT = 'https://infer.example';
    require('../sentry-init');
    expect(mockSetContext).toHaveBeenCalledWith(
      'runtime_endpoints',
      expect.objectContaining({
        auth: 'https://auth.example',
        graphql: 'https://gql.example',
        inference: 'https://infer.example',
      }),
    );
  });

  it('sets inference_endpoint tag', () => {
    process.env.EXPO_PUBLIC_INFERENCE_ENDPOINT = 'https://infer.example';
    require('../sentry-init');
    expect(mockSetTag).toHaveBeenCalledWith(
      'inference_endpoint',
      'https://infer.example',
    );
  });

  it('sets inference_endpoint tag to "unset" when env var is missing', () => {
    delete process.env.EXPO_PUBLIC_INFERENCE_ENDPOINT;
    require('../sentry-init');
    expect(mockSetTag).toHaveBeenCalledWith('inference_endpoint', 'unset');
  });

  describe('static build tags', () => {
    // Not just "some tags are set": ota_update_id is the only way to tell which
    // JS bundle a crash came from, since Sentry's `release` tracks the native
    // build only. Losing it silently is the failure this asserts against.
    it('sets one tag per static app-context field, stringified', () => {
      require('../sentry-init');
      expect(mockSetTag).toHaveBeenCalledWith('app_version', '1.2.3');
      expect(mockSetTag).toHaveBeenCalledWith('app_build', '456');
      expect(mockSetTag).toHaveBeenCalledWith('ota_update_id', 'update-abc');
      expect(mockSetTag).toHaveBeenCalledWith('ota_channel', 'production');
      expect(mockSetTag).toHaveBeenCalledWith('runtime_version', '1.2.3');
      // Booleans must arrive as strings — Sentry tag values are strings.
      expect(mockSetTag).toHaveBeenCalledWith('is_embedded_launch', 'false');
    });

    it('mirrors the static context into a mera_app_build context block', () => {
      require('../sentry-init');
      expect(mockSetContext).toHaveBeenCalledWith(
        'mera_app_build',
        expect.objectContaining({ ota_update_id: 'update-abc' }),
      );
    });
  });

  describe('beforeSend scrubber', () => {
    let capturedBeforeSend: ((event: any) => any) | null = null;

    beforeEach(() => {
      jest.resetModules();
      jest.clearAllMocks();
      (global as any).__DEV__ = false;
      process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://test@sentry.io/1';
      process.env.EXPO_PUBLIC_AUTH_ENDPOINT = 'https://auth.test';
      process.env.EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT = 'https://api.test';
      process.env.EXPO_PUBLIC_INFERENCE_ENDPOINT = 'https://infer.test';

      mockSentryInit.mockImplementation((config: any) => {
        capturedBeforeSend = config.beforeSend;
      });
      require('../sentry-init');
    });

    // The user object is ALLOWLISTED, not denylisted: `id` is the join key to
    // RevenueCat/UserBilling and support triage, everything else is PII.
    it('keeps user.id', () => {
      const event = { user: { id: 'u1', email: 'u@test.com' }, extra: {} };
      const result = capturedBeforeSend!(event);
      expect(result.user).toEqual({ id: 'u1' });
    });

    it('strips email, username and ip_address from event.user', () => {
      const event = {
        user: {
          id: 'u1',
          email: 'u@test.com',
          username: 'someone',
          ip_address: '203.0.113.9',
        },
        extra: {},
      };
      const result = capturedBeforeSend!(event);
      expect(result.user.email).toBeUndefined();
      expect(result.user.username).toBeUndefined();
      expect(result.user.ip_address).toBeUndefined();
    });

    it('drops unknown user keys rather than passing them through', () => {
      // A field a future SDK version adds must not ship by default.
      const event = { user: { id: 'u1', segment: 'beta', geo: {} }, extra: {} };
      const result = capturedBeforeSend!(event);
      expect(Object.keys(result.user)).toEqual(['id']);
    });

    it('deletes event.user entirely when there is no id (SDK-attached ip only)', () => {
      const event = { user: { ip_address: '203.0.113.9' }, extra: {} };
      const result = capturedBeforeSend!(event);
      expect(result.user).toBeUndefined();
    });

    it('strips request cookies and headers', () => {
      const event = {
        request: { cookies: 'session=abc', headers: { Authorization: 'Bearer token' } },
        extra: {},
      };
      const result = capturedBeforeSend!(event);
      expect(result.request.cookies).toBeUndefined();
      expect(result.request.headers).toBeUndefined();
    });

    it('caps extra string values longer than 200 chars', () => {
      const longStr = 'x'.repeat(300);
      const event = { extra: { body: longStr }, request: {} };
      const result = capturedBeforeSend!(event);
      expect(result.extra.body).toMatch(/^\[redacted:300\]$/);
    });

    it('leaves extra string values <= 200 chars untouched', () => {
      const shortStr = 'hello world';
      const event = { extra: { msg: shortStr }, request: {} };
      const result = capturedBeforeSend!(event);
      expect(result.extra.msg).toBe('hello world');
    });

    it('caps breadcrumb data values longer than 200 chars', () => {
      const longStr = 'y'.repeat(250);
      const event = {
        extra: {},
        breadcrumbs: [{ data: { payload: longStr } }],
        request: {},
      };
      const result = capturedBeforeSend!(event);
      expect(result.breadcrumbs[0].data.payload).toMatch(/^\[redacted:250\]$/);
    });

    it('handles nested extra objects (recursive cap)', () => {
      const longStr = 'z'.repeat(201);
      const event = { extra: { nested: { deep: longStr } }, request: {} };
      const result = capturedBeforeSend!(event);
      expect(result.extra.nested.deep).toMatch(/^\[redacted:201\]$/);
    });

    it('returns the event (not null)', () => {
      const event = { extra: {}, request: {} };
      expect(capturedBeforeSend!(event)).toBe(event);
    });

    // The cap used to skip arrays outright, so `string[]` — the shape logger
    // call sites push most often — bypassed redaction entirely.
    it('caps over-long strings inside arrays', () => {
      const longStr = 'a'.repeat(400);
      const event = { extra: { items: ['ok', longStr] }, request: {} };
      const result = capturedBeforeSend!(event);
      expect(result.extra.items[0]).toBe('ok');
      expect(result.extra.items[1]).toBe('[redacted:400]');
    });

    it('caps over-long strings in objects nested inside arrays', () => {
      const longStr = 'b'.repeat(500);
      const event = { extra: { rows: [{ body: longStr }] }, request: {} };
      const result = capturedBeforeSend!(event);
      expect(result.extra.rows[0].body).toBe('[redacted:500]');
    });

    it('caps over-long strings in arrays nested inside arrays', () => {
      const longStr = 'c'.repeat(210);
      const event = { extra: { grid: [['ok', longStr]] }, request: {} };
      const result = capturedBeforeSend!(event);
      expect(result.extra.grid[0][1]).toBe('[redacted:210]');
    });

    describe('key-name denylist', () => {
      // The length cap misses exactly the leaks that matter most: a userId, an
      // email, an article title and a topic string all fit inside 200 chars.
      it.each([
        'email',
        'userEmail',
        'token',
        'statement',
        'topic',
        'topics',
        'text',
        'title',
        'prompt',
        'content',
        'cookie',
        'apiKey',
        'secret',
        'password',
        'Authorization',
      ])('redacts short values under the key %s', (key) => {
        const event = { extra: { [key]: 'short-but-sensitive' }, request: {} };
        const result = capturedBeforeSend!(event);
        expect(result.extra[key]).toBe('[redacted:key]');
      });

      it('matches case-insensitively and inside nested objects', () => {
        const event = { extra: { nested: { EMAIL: 'a@b.c' } }, request: {} };
        const result = capturedBeforeSend!(event);
        expect(result.extra.nested.EMAIL).toBe('[redacted:key]');
      });

      it('redacts a denylisted key whose value is an object, without recursing', () => {
        const event = { extra: { prompt: { system: 'hi' } }, request: {} };
        const result = capturedBeforeSend!(event);
        expect(result.extra.prompt).toBe('[redacted:key]');
      });

      it('leaves null/undefined under a denylisted key alone', () => {
        // "absent" and "scrubbed" must stay distinguishable when triaging.
        const event = { extra: { token: null }, request: {} };
        const result = capturedBeforeSend!(event);
        expect(result.extra.token).toBeNull();
      });

      it('applies to breadcrumb data too', () => {
        const event = {
          extra: {},
          breadcrumbs: [{ data: { email: 'a@b.c' } }],
          request: {},
        };
        const result = capturedBeforeSend!(event);
        expect(result.breadcrumbs[0].data.email).toBe('[redacted:key]');
      });

      it('leaves non-denylisted short keys untouched', () => {
        const event = { extra: { status: 404, method: 'POST' }, request: {} };
        const result = capturedBeforeSend!(event);
        expect(result.extra.status).toBe(404);
        expect(result.extra.method).toBe('POST');
      });
    });
  });
});

describe('sentry-init (dev path: __DEV__ = true)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    (global as any).__DEV__ = true;
  });

  it('does NOT call Sentry.init in dev mode', () => {
    require('../sentry-init');
    expect(mockSentryInit).not.toHaveBeenCalled();
  });
});
