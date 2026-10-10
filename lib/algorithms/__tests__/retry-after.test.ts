import { retryAfterMs } from '../retry-after';

const OPTS = { defaultMs: 30_000, maxMs: 60_000 };

// Reference: lib/llm/cloudComplete.ts retryAfterMsFrom (lines 175-182).
function cloudCompleteRef(raw: string | null | undefined): number {
  const seconds = raw != null ? Number(raw) : NaN;
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : OPTS.defaultMs;
  return Math.min(ms, OPTS.maxMs);
}

// Reference: lib/e2ee/e2ee-service.ts attestation 429 branch (lines 283-288).
function e2eeRef(raw: string | null | undefined): number {
  const sec = raw ? Number(raw) : NaN;
  return Number.isFinite(sec) && sec > 0 ? Math.min(sec * 1000, 60_000) : 30_000;
}

describe('retryAfterMs', () => {
  it.each([
    ['', 30_000],
    [null, 30_000],
    [undefined, 30_000],
    ['0', 30_000],
    ['-3', 30_000],
    ['abc', 30_000],
    ['2', 2_000],
    ['120', 60_000],
    ['1.5', 1_500],
  ] as [string | null | undefined, number][])('%j -> %d, same as both old copies', (raw, expected) => {
    expect(retryAfterMs(raw, OPTS)).toBe(expected);
    expect(cloudCompleteRef(raw)).toBe(expected);
    expect(e2eeRef(raw)).toBe(expected);
  });
});
