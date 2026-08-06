// Supplemental tests for sentry-init.ts.
// Covers branches NOT exercised by the primary sentry-init.test.ts:
//  • scrubEventValues(undefined) → early-return
//  • array recursion (the branch that used to be skipped outright)
//  • runtime_endpoints context when auth/graphql env vars are missing
//  • the static build tags degrading rather than throwing when a native module
//    read fails

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

// See the note in sentry-init.test.ts — expo-application/expo-updates have no
// global mock, and sentry-init reaches them via observability/app-context.ts.
jest.mock('expo-application', () => ({
  nativeApplicationVersion: '1.2.3',
  nativeBuildVersion: '456',
}));
// `updateId` is a getter so one case can make the native read throw — sentry-init
// is the app's FIRST import, so a native module failing there must degrade to
// "no build tags" and never take the bundle down.
let mockUpdatesThrows = false;
jest.mock('expo-updates', () => ({
  get updateId() {
    if (mockUpdatesThrows) throw new Error('native module unavailable');
    return 'update-abc';
  },
  channel: 'production',
  runtimeVersion: '1.2.3',
  isEmbeddedLaunch: false,
}));

describe('sentry-init supplemental — scrubEventValues edge cases', () => {
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

  it('does not throw when event.extra is undefined (scrubEventValues early return)', () => {
    // event.extra is undefined → scrubEventValues(undefined) → early return
    const event = { request: {} }; // no `extra` key
    expect(() => capturedBeforeSend!(event)).not.toThrow();
    // event should still be returned (not null)
    expect(capturedBeforeSend!(event)).toBe(event);
  });

  it('does not throw when event.extra is explicitly undefined', () => {
    const event: any = { extra: undefined, request: {} };
    expect(() => capturedBeforeSend!(event)).not.toThrow();
  });

  it('walks array values in extra without replacing the array itself', () => {
    // Arrays are recursed INTO (they used to be skipped entirely), but the
    // container is mutated in place rather than swapped out.
    const arrayVal = ['item1', 'item2'];
    const event = { extra: { list: arrayVal }, request: {} };
    const result = capturedBeforeSend!(event);
    expect(result.extra.list).toBe(arrayVal);
    expect(result.extra.list).toEqual(['item1', 'item2']);
  });

  it('does not throw when breadcrumb.data is undefined (scrubEventValues early return)', () => {
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

describe('sentry-init supplemental — static build tags degrade safely', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    (global as any).__DEV__ = false;
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://test@sentry.io/1';
    process.env.EXPO_PUBLIC_INFERENCE_ENDPOINT = 'https://infer.test';
    mockUpdatesThrows = true;
  });

  afterEach(() => {
    (global as any).__DEV__ = true;
    mockUpdatesThrows = false;
  });

  it('still initialises Sentry when a native build-fact read throws', () => {
    expect(() => require('../sentry-init')).not.toThrow();
    expect(mockSentryInit).toHaveBeenCalled();
    // The endpoint tag is set before the build facts, so it survives.
    expect(mockSetTag).toHaveBeenCalledWith(
      'inference_endpoint',
      'https://infer.test',
    );
    expect(mockSetContext).not.toHaveBeenCalledWith(
      'mera_app_build',
      expect.anything(),
    );
  });
});
