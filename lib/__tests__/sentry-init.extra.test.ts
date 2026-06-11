// Supplemental tests for sentry-init.ts.
// Covers branches NOT exercised by the primary sentry-init.test.ts:
//  • capStringValues(undefined) → line 28 early-return
//  • capStringValues with an array-valued key → !Array.isArray(value) = false branch
//  • runtime_endpoints context when auth/graphql env vars are missing (lines 79-80)

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

describe('sentry-init supplemental — capStringValues edge cases', () => {
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

  afterEach(() => {
    (global as any).__DEV__ = true;
  });

  it('does not throw when event.extra is undefined (capStringValues early return)', () => {
    // event.extra is undefined → capStringValues(undefined) → early return at line 28
    const event = { request: {} }; // no `extra` key
    expect(() => capturedBeforeSend!(event)).not.toThrow();
    // event should still be returned (not null)
    expect(capturedBeforeSend!(event)).toBe(event);
  });

  it('does not throw when event.extra is explicitly undefined', () => {
    const event: any = { extra: undefined, request: {} };
    expect(() => capturedBeforeSend!(event)).not.toThrow();
  });

  it('does not recurse into array values in extra (array branch in capStringValues)', () => {
    // When a value is an array, the !Array.isArray(value) check is false —
    // the recursion should be skipped. The array should be left untouched.
    const arrayVal = ['item1', 'item2'];
    const event = { extra: { list: arrayVal }, request: {} };
    const result = capturedBeforeSend!(event);
    // The array itself should still be there (not redacted)
    expect(result.extra.list).toBe(arrayVal);
    expect(Array.isArray(result.extra.list)).toBe(true);
  });

  it('does not throw when breadcrumb.data is undefined (capStringValues early return)', () => {
    const event = {
      extra: {},
      breadcrumbs: [{ category: 'info' }], // no `data` field
      request: {},
    };
    expect(() => capturedBeforeSend!(event)).not.toThrow();
  });

  it('leaves short strings (<= 200 chars) in nested extra objects untouched', () => {
    const event = { extra: { nested: { msg: 'short' } }, request: {} };
    const result = capturedBeforeSend!(event);
    expect(result.extra.nested.msg).toBe('short');
  });

  it('leaves non-string values (numbers, booleans, null) in extra untouched', () => {
    const event = {
      extra: { count: 42, flag: true, nothing: null },
      request: {},
    };
    const result = capturedBeforeSend!(event);
    expect(result.extra.count).toBe(42);
    expect(result.extra.flag).toBe(true);
    expect(result.extra.nothing).toBeNull();
  });
});

describe('sentry-init supplemental — null endpoint values in setContext', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    (global as any).__DEV__ = false;
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://test@sentry.io/1';
    process.env.EXPO_PUBLIC_INFERENCE_ENDPOINT = 'https://infer.test';
    // Intentionally omit AUTH and GRAPHQL so lines 79-80 hit the null branch
    delete process.env.EXPO_PUBLIC_AUTH_ENDPOINT;
    delete process.env.EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT;
  });

  afterEach(() => {
    (global as any).__DEV__ = true;
    delete process.env.EXPO_PUBLIC_AUTH_ENDPOINT;
    delete process.env.EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT;
  });

  it('sets auth to null in runtime_endpoints when EXPO_PUBLIC_AUTH_ENDPOINT is unset', () => {
    require('../sentry-init');
    expect(mockSetContext).toHaveBeenCalledWith(
      'runtime_endpoints',
      expect.objectContaining({ auth: null }),
    );
  });

  it('sets graphql to null in runtime_endpoints when EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT is unset', () => {
    require('../sentry-init');
    expect(mockSetContext).toHaveBeenCalledWith(
      'runtime_endpoints',
      expect.objectContaining({ graphql: null }),
    );
  });
});
