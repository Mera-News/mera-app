// endpoints.ts reads process.env.EXPO_PUBLIC_* at module load. We must use
// jest.resetModules() + dynamic require to test different env states.

const mockSentryCaptureException = jest.fn();

jest.mock('@sentry/react-native', () => ({
  captureException: mockSentryCaptureException,
  init: jest.fn(),
  setContext: jest.fn(),
  setTag: jest.fn(),
}));

describe('config/endpoints', () => {
  const REQUIRED_VARS = {
    EXPO_PUBLIC_INFERENCE_ENDPOINT: 'https://inference.test',
    EXPO_PUBLIC_AUTH_ENDPOINT: 'https://auth.test',
    EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT: 'https://api.test',
  };

  function setEnv(overrides: Partial<typeof REQUIRED_VARS> = {}) {
    Object.assign(process.env, REQUIRED_VARS, overrides);
  }

  function clearEnv() {
    for (const key of Object.keys(REQUIRED_VARS)) {
      delete process.env[key];
    }
  }

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  afterEach(() => {
    clearEnv();
  });

  it('exports INFERENCE_ENDPOINT when env var is set', () => {
    setEnv();
    const { INFERENCE_ENDPOINT } = require('../endpoints');
    expect(INFERENCE_ENDPOINT).toBe('https://inference.test');
  });

  it('exports AUTH_ENDPOINT when env var is set', () => {
    setEnv();
    const { AUTH_ENDPOINT } = require('../endpoints');
    expect(AUTH_ENDPOINT).toBe('https://auth.test');
  });

  it('exports GRAPHQL_SERVER_ENDPOINT when env var is set', () => {
    setEnv();
    const { GRAPHQL_SERVER_ENDPOINT } = require('../endpoints');
    expect(GRAPHQL_SERVER_ENDPOINT).toBe('https://api.test');
  });

  it('throws when INFERENCE_ENDPOINT is missing', () => {
    setEnv({ EXPO_PUBLIC_INFERENCE_ENDPOINT: undefined } as any);
    delete process.env.EXPO_PUBLIC_INFERENCE_ENDPOINT;
    expect(() => require('../endpoints')).toThrow(
      /Missing required env var EXPO_PUBLIC_INFERENCE_ENDPOINT/,
    );
  });

  it('throws when AUTH_ENDPOINT is missing', () => {
    setEnv();
    delete process.env.EXPO_PUBLIC_AUTH_ENDPOINT;
    expect(() => require('../endpoints')).toThrow(
      /Missing required env var EXPO_PUBLIC_AUTH_ENDPOINT/,
    );
  });

  it('throws when GRAPHQL_SERVER_ENDPOINT is missing', () => {
    setEnv();
    delete process.env.EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT;
    expect(() => require('../endpoints')).toThrow(
      /Missing required env var EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT/,
    );
  });

  it('calls Sentry.captureException before throwing on missing env var', () => {
    delete process.env.EXPO_PUBLIC_INFERENCE_ENDPOINT;
    delete process.env.EXPO_PUBLIC_AUTH_ENDPOINT;
    delete process.env.EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT;
    try {
      require('../endpoints');
    } catch {
      // expected
    }
    expect(mockSentryCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ module: 'config/endpoints' }) }),
    );
  });

  it('exports DUMP_QUERIES_ENABLED as false when env var is not set', () => {
    setEnv();
    delete process.env.EXPO_PUBLIC_DUMP_QUERY_FOR_DEBUGGING;
    const { DUMP_QUERIES_ENABLED } = require('../endpoints');
    // __DEV__ is true in tests, but value is 'true' check: undefined !== 'true' → false
    expect(DUMP_QUERIES_ENABLED).toBe(false);
  });

  it('exports DUMP_QUERIES_ENABLED as true when __DEV__ and env var both are true', () => {
    setEnv();
    process.env.EXPO_PUBLIC_DUMP_QUERY_FOR_DEBUGGING = 'true';
    // __DEV__ is true in jest globals
    const { DUMP_QUERIES_ENABLED } = require('../endpoints');
    expect(DUMP_QUERIES_ENABLED).toBe(true);
    delete process.env.EXPO_PUBLIC_DUMP_QUERY_FOR_DEBUGGING;
  });

  it('throws an Error with a helpful message mentioning .env.example', () => {
    delete process.env.EXPO_PUBLIC_AUTH_ENDPOINT;
    try {
      setEnv({ EXPO_PUBLIC_AUTH_ENDPOINT: undefined } as any);
      delete process.env.EXPO_PUBLIC_AUTH_ENDPOINT;
      require('../endpoints');
      fail('should have thrown');
    } catch (err: any) {
      expect(err.message).toMatch(/\.env\.example/);
    }
  });
});
