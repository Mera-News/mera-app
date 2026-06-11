// Tests for lib/llm/constants.ts — model name constants and derived values.

import { BIG_MODEL, SMALL_MODEL, NOISE_MULTIPLIER } from '../constants';

describe('llm/constants', () => {
  describe('BIG_MODEL', () => {
    it('is a non-empty string', () => {
      expect(typeof BIG_MODEL).toBe('string');
      expect(BIG_MODEL.length).toBeGreaterThan(0);
    });

    it('contains the expected model identifier', () => {
      expect(BIG_MODEL).toBe('deepseek-ai/DeepSeek-V4-Flash');
    });

    it('follows the provider/model-name pattern', () => {
      expect(BIG_MODEL).toMatch(/^[^/]+\/.+$/);
    });
  });

  describe('SMALL_MODEL', () => {
    it('is a non-empty string', () => {
      expect(typeof SMALL_MODEL).toBe('string');
      expect(SMALL_MODEL.length).toBeGreaterThan(0);
    });

    it('contains the expected model identifier', () => {
      expect(SMALL_MODEL).toBe('Qwen/Qwen3.6-35B-A3B-FP8');
    });

    it('follows the provider/model-name pattern', () => {
      expect(SMALL_MODEL).toMatch(/^[^/]+\/.+$/);
    });

    it('is distinct from BIG_MODEL', () => {
      expect(SMALL_MODEL).not.toBe(BIG_MODEL);
    });
  });

  describe('NOISE_MULTIPLIER', () => {
    it('is a positive number', () => {
      expect(typeof NOISE_MULTIPLIER).toBe('number');
      expect(NOISE_MULTIPLIER).toBeGreaterThan(0);
    });

    it('equals 1 (parity — one decoy per real topic)', () => {
      expect(NOISE_MULTIPLIER).toBe(1);
    });
  });
});
