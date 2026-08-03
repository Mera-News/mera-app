// Tests for lib/llm/model-fallback.ts — session-scoped primary→fallback switch.
// Pure module; only the logger is mocked (the real one pulls in Sentry).

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureMessage: jest.fn(),
    captureException: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  },
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
    it('maps both primaries to the TEE-served fallback', () => {
      expect(MODEL_FALLBACKS[SMALL_MODEL]).toBe('google/gemma-4-31B-it');
      expect(MODEL_FALLBACKS[BIG_MODEL]).toBe('openai/gpt-oss-120b');
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
