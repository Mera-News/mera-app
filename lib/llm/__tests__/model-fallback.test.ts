// Tests for lib/llm/model-fallback.ts — session-scoped primary→fallback switch.
// The logger is mocked (the real one pulls in Sentry) and so is the network
// store, whose real module reaches NetInfo.

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureMessage: jest.fn(),
    captureException: jest.fn(),
    addBreadcrumb: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  },
}));

let mockIsConnected = true;
jest.mock('@/lib/stores/network-store', () => ({
  useNetworkStore: { getState: () => ({ isConnected: mockIsConnected }) },
}));

import {
  __resetForTests,
  fallbackFor,
  isFallbackEngaged,
  reportModelFailure,
  reportModelSlow,
  reportModelSuccess,
  resolveModel,
} from '../model-fallback';
import { BIG_MODEL, MODEL_FALLBACKS, SMALL_MODEL } from '../constants';
import logger from '@/lib/logger';

const UNKNOWN_MODEL = 'some/model-with-no-fallback';

describe('model-fallback', () => {
  beforeEach(() => {
    __resetForTests();
    (logger.captureMessage as jest.Mock).mockReset();
  });

  afterEach(() => {
    __resetForTests();
  });

  describe('MODEL_FALLBACKS wiring', () => {
    it('maps each primary to its class-appropriate TEE-served fallback', () => {
      // BIG backs the persona chat, which needs FUNCTION TOOL CALLING — a live
      // probe (2026-08-03) showed GLM-5.1 is the only ready non-primary model
      // that returns schema-conformant tool arguments. SMALL uses JSON mode, so
      // the cheaper Gemma is right there. Rationale in constants.ts.
      expect(MODEL_FALLBACKS[BIG_MODEL]).toBe('zai-org/GLM-5.1-FP8');
      expect(MODEL_FALLBACKS[SMALL_MODEL]).toBe('google/gemma-4-31B-it');
    });

    it('never falls back to a model that is its own primary', () => {
      for (const [primary, fallback] of Object.entries(MODEL_FALLBACKS)) {
        expect(fallback).not.toBe(primary);
      }
    });
  });

  describe('resolveModel', () => {
    it('returns the model unchanged before any failure', () => {
      expect(resolveModel(SMALL_MODEL)).toBe(SMALL_MODEL);
      expect(resolveModel(BIG_MODEL)).toBe(BIG_MODEL);
    });

    it('returns the fallback once engaged', () => {
      reportModelFailure(SMALL_MODEL);
      expect(resolveModel(SMALL_MODEL)).toBe(MODEL_FALLBACKS[SMALL_MODEL]);
    });

    it('engagement is per-model — other primaries are untouched', () => {
      reportModelFailure(SMALL_MODEL);
      expect(resolveModel(BIG_MODEL)).toBe(BIG_MODEL);
    });

    it('leaves a model with no configured fallback alone', () => {
      reportModelFailure(UNKNOWN_MODEL);
      expect(resolveModel(UNKNOWN_MODEL)).toBe(UNKNOWN_MODEL);
      expect(isFallbackEngaged(UNKNOWN_MODEL)).toBe(false);
    });
  });

  describe('reportModelFailure', () => {
    it('engages the fallback', () => {
      expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
      reportModelFailure(SMALL_MODEL);
      expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
    });

    it('reports to Sentry exactly once per model per session', () => {
      reportModelFailure(SMALL_MODEL);
      reportModelFailure(SMALL_MODEL);
      reportModelFailure(SMALL_MODEL);

      expect(logger.captureMessage as jest.Mock).toHaveBeenCalledTimes(1);
      expect(logger.captureMessage as jest.Mock).toHaveBeenCalledWith(
        'NEAR primary model failing — session fallback engaged',
        {
          level: 'error',
          tags: { model: SMALL_MODEL, fallback: MODEL_FALLBACKS[SMALL_MODEL] },
        },
      );
    });

    it('reports separately for a second primary', () => {
      reportModelFailure(SMALL_MODEL);
      reportModelFailure(BIG_MODEL);
      expect(logger.captureMessage as jest.Mock).toHaveBeenCalledTimes(2);
    });

    it('never reports for a model with no configured fallback', () => {
      reportModelFailure(UNKNOWN_MODEL);
      expect(logger.captureMessage as jest.Mock).not.toHaveBeenCalled();
    });
  });

  describe('fallbackFor', () => {
    it('maps a configured primary to its fallback', () => {
      expect(fallbackFor(SMALL_MODEL)).toBe(MODEL_FALLBACKS[SMALL_MODEL]);
      expect(fallbackFor(BIG_MODEL)).toBe(MODEL_FALLBACKS[BIG_MODEL]);
    });

    it('returns null for a model with no configured fallback', () => {
      expect(fallbackFor(UNKNOWN_MODEL)).toBeNull();
    });

    it('is unaffected by engagement (it reports config, not state)', () => {
      reportModelFailure(SMALL_MODEL);
      expect(fallbackFor(SMALL_MODEL)).toBe(MODEL_FALLBACKS[SMALL_MODEL]);
    });
  });

  describe('reportModelSlow', () => {
    it('engages the fallback, like a timeout does', () => {
      reportModelSlow(SMALL_MODEL);
      expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
      expect(resolveModel(SMALL_MODEL)).toBe(MODEL_FALLBACKS[SMALL_MODEL]);
    });

    it('reports at WARNING with its own message — a slow primary is not a dead one', () => {
      reportModelSlow(SMALL_MODEL);
      expect(logger.captureMessage as jest.Mock).toHaveBeenCalledTimes(1);
      expect(logger.captureMessage as jest.Mock).toHaveBeenCalledWith(
        'NEAR primary model slow — hedged fallback won, session fallback engaged',
        {
          level: 'warning',
          tags: { model: SMALL_MODEL, fallback: MODEL_FALLBACKS[SMALL_MODEL] },
        },
      );
    });

    it('never engages or reports for a model with no configured fallback', () => {
      reportModelSlow(UNKNOWN_MODEL);
      expect(isFallbackEngaged(UNKNOWN_MODEL)).toBe(false);
      expect(logger.captureMessage as jest.Mock).not.toHaveBeenCalled();
    });

    it('dedupes with reportModelFailure: slow → failure is ONE event', () => {
      reportModelSlow(SMALL_MODEL);
      reportModelFailure(SMALL_MODEL);
      reportModelSlow(SMALL_MODEL);

      expect(logger.captureMessage as jest.Mock).toHaveBeenCalledTimes(1);
      expect((logger.captureMessage as jest.Mock).mock.calls[0][1].level).toBe('warning');
    });

    it('dedupes with reportModelFailure: failure → slow is ONE event', () => {
      reportModelFailure(SMALL_MODEL);
      reportModelSlow(SMALL_MODEL);

      expect(logger.captureMessage as jest.Mock).toHaveBeenCalledTimes(1);
      expect((logger.captureMessage as jest.Mock).mock.calls[0][1].level).toBe('error');
    });
  });

  describe('reportModelSuccess', () => {
    it('never engages anything', () => {
      reportModelSuccess(SMALL_MODEL);
      expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
      expect(resolveModel(SMALL_MODEL)).toBe(SMALL_MODEL);
      expect(logger.captureMessage as jest.Mock).not.toHaveBeenCalled();
    });

    it('does NOT un-engage an engaged fallback — the session keeps it', () => {
      reportModelFailure(SMALL_MODEL);
      reportModelSuccess(SMALL_MODEL);
      reportModelSuccess(SMALL_MODEL);
      expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
      expect(resolveModel(SMALL_MODEL)).toBe(MODEL_FALLBACKS[SMALL_MODEL]);
    });
  });

  describe('a fresh process always retries the primary', () => {
    it('holds engagement in module memory only — nothing is persisted', () => {
      // The user-facing contract: "once the app restarts, always use the
      // primary model first again". Engagement lives in a module-level Map, so
      // it dies with the JS context and a relaunched app starts on the primary.
      // A regression here would be someone adding storage/hydration; this
      // asserts the module reaches for neither.
      reportModelFailure(SMALL_MODEL);
      expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);

      jest.resetModules(); // simulates the process restart
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fresh = require('../model-fallback') as typeof import('../model-fallback');
      expect(fresh.isFallbackEngaged(SMALL_MODEL)).toBe(false);
      expect(fresh.resolveModel(SMALL_MODEL)).toBe(SMALL_MODEL);
    });
  });

  describe('__resetForTests', () => {
    it('isolates sessions — engagement and the once-per-session report both reset', () => {
      reportModelFailure(SMALL_MODEL);
      expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);

      __resetForTests();

      expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
      expect(resolveModel(SMALL_MODEL)).toBe(SMALL_MODEL);

      reportModelFailure(SMALL_MODEL);
      // Reported again: a reset simulates a fresh app launch, which is exactly
      // how the primary gets retried in production.
      expect(logger.captureMessage as jest.Mock).toHaveBeenCalledTimes(2);
    });

    it('clears a hedge engagement too (both causes share one guard set)', () => {
      reportModelSlow(SMALL_MODEL);
      __resetForTests();
      expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
      expect(resolveModel(SMALL_MODEL)).toBe(SMALL_MODEL);
    });
  });
});


// MERA-APP-6Y. cloudComplete only forwards TIMEOUT-class failures here, but an
// offline device on a stalled socket produces a timeout too — so a backgrounded
// phone with no link concluded the NEAR primary was down and demoted the whole
// session to the fallback. Engagement is sticky and once-per-session, so one
// tunnel cost every later call.
describe('reportModelFailure connectivity gate', () => {
  beforeEach(() => {
    __resetForTests();
    jest.clearAllMocks();
    mockIsConnected = true;
  });

  afterEach(() => {
    mockIsConnected = true;
  });

  it('does not engage the fallback while the device is offline', () => {
    mockIsConnected = false;

    reportModelFailure(BIG_MODEL);

    expect(isFallbackEngaged(BIG_MODEL)).toBe(false);
    expect(resolveModel(BIG_MODEL)).toBe(BIG_MODEL);
    expect(logger.captureMessage).not.toHaveBeenCalled();
    expect(logger.addBreadcrumb).toHaveBeenCalledWith(
      expect.stringContaining('device offline'),
      'model-fallback',
      expect.objectContaining({ model: BIG_MODEL }),
      'info',
    );
  });

  it('still engages once the device is back online', () => {
    mockIsConnected = false;
    reportModelFailure(BIG_MODEL);
    expect(isFallbackEngaged(BIG_MODEL)).toBe(false);

    mockIsConnected = true;
    reportModelFailure(BIG_MODEL);

    expect(isFallbackEngaged(BIG_MODEL)).toBe(true);
    expect(resolveModel(BIG_MODEL)).toBe(MODEL_FALLBACKS[BIG_MODEL]);
  });

  // isConnected is seeded optimistically true, so an unknown connectivity state
  // must still report — erring toward a visible incident, not a silent one.
  it('engages when connectivity is unknown-but-optimistic', () => {
    mockIsConnected = true;

    reportModelFailure(SMALL_MODEL);

    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
  });
});
