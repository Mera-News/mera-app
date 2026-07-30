// EXPO_PUBLIC_USE_ARTICLE_TAGS — the env-binding half.
//
// Both modules under test read `process.env` at MODULE LOAD (the Metro/Babel
// inlining contract that lib/config/endpoints.ts exists to centralise), so every
// case needs jest.resetModules() + a dynamic require — the same pattern
// endpoints.test.ts uses.

const mockSentryCaptureException = jest.fn();

jest.mock('@sentry/react-native', () => ({
  captureException: mockSentryCaptureException,
  init: jest.fn(),
  setContext: jest.fn(),
  setTag: jest.fn(),
}));

describe('EXPO_PUBLIC_USE_ARTICLE_TAGS → config/endpoints', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.EXPO_PUBLIC_USE_ARTICLE_TAGS;
  });

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_USE_ARTICLE_TAGS;
  });

  it('DEFAULTS TO OFF when the env var is not set at all', () => {
    const { USE_ARTICLE_TAGS } = require('@/lib/config/endpoints');
    expect(USE_ARTICLE_TAGS).toBe(false);
  });

  it('is on only for the exact string "true"', () => {
    process.env.EXPO_PUBLIC_USE_ARTICLE_TAGS = 'true';
    const { USE_ARTICLE_TAGS } = require('@/lib/config/endpoints');
    expect(USE_ARTICLE_TAGS).toBe(true);
  });

  // A truthy-but-wrong value must NOT enable it: this switch changes how every
  // article is scored, so a typo has to fail safe (and closed).
  it.each(['1', 'yes', 'TRUE', 'True', '', 'false'])(
    'stays off for %p',
    (value) => {
      process.env.EXPO_PUBLIC_USE_ARTICLE_TAGS = value;
      const { USE_ARTICLE_TAGS } = require('@/lib/config/endpoints');
      expect(USE_ARTICLE_TAGS).toBe(false);
    },
  );
});

describe('HARNESS_CONFIG_BASE — the composition root', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.EXPO_PUBLIC_USE_ARTICLE_TAGS;
  });

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_USE_ARTICLE_TAGS;
  });

  it('with the flag unset, hands back DEFAULT_HARNESS_CONFIG ITSELF', () => {
    // Reference equality, not deep equality. `applyScoringOverrides` returns its
    // base object untouched when there are no calibration overrides, and
    // `effectiveHarnessConfig` uses `eng === base` to skip an allocation — a
    // copy here would silently defeat that.
    const { HARNESS_CONFIG_BASE } = require('../harness-config-base');
    const { DEFAULT_HARNESS_CONFIG } = require('@/lib/news-harness/core/config');
    expect(HARNESS_CONFIG_BASE).toBe(DEFAULT_HARNESS_CONFIG);
    expect(HARNESS_CONFIG_BASE.scoringEngine.USE_ARTICLE_TAGS).toBe(false);
  });

  it('with the flag on, overrides USE_ARTICLE_TAGS and nothing else', () => {
    process.env.EXPO_PUBLIC_USE_ARTICLE_TAGS = 'true';
    const { HARNESS_CONFIG_BASE } = require('../harness-config-base');
    const { DEFAULT_HARNESS_CONFIG } = require('@/lib/news-harness/core/config');

    expect(HARNESS_CONFIG_BASE.scoringEngine.USE_ARTICLE_TAGS).toBe(true);
    expect({ ...HARNESS_CONFIG_BASE.scoringEngine, USE_ARTICLE_TAGS: false }).toEqual(
      DEFAULT_HARNESS_CONFIG.scoringEngine,
    );
    // The other sub-configs are passed through by reference — the flag is a
    // scoring-engine concern only.
    expect(HARNESS_CONFIG_BASE.articlePipeline).toBe(DEFAULT_HARNESS_CONFIG.articlePipeline);
    expect(HARNESS_CONFIG_BASE.topicGen).toBe(DEFAULT_HARNESS_CONFIG.topicGen);
    expect(HARNESS_CONFIG_BASE.mutationRails).toBe(DEFAULT_HARNESS_CONFIG.mutationRails);
  });
});
