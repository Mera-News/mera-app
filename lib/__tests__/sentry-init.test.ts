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

    it('strips event.user', () => {
      const event = { user: { id: 'u1', email: 'u@test.com' }, extra: {} };
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
