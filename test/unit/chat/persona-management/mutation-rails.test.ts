import {
  clampWeight,
  nudgeTopicWeight,
} from '@/lib/news-harness/persona-management/mutation-rails';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';

const R = DEFAULT_HARNESS_CONFIG.mutationRails;

describe('clampWeight', () => {
  it('clamps to [-1, 1]', () => {
    expect(clampWeight(0)).toBe(0);
    expect(clampWeight(0.5)).toBe(0.5);
    expect(clampWeight(1)).toBe(1);
    expect(clampWeight(-1)).toBe(-1);
    expect(clampWeight(1.4)).toBe(1);
    expect(clampWeight(-2.7)).toBe(-1);
  });

  it('maps NaN to 0', () => {
    expect(clampWeight(Number.NaN)).toBe(0);
  });
});

describe('nudgeTopicWeight', () => {
  it('applies a delta within budget and range', () => {
    const r = nudgeTopicWeight(0.5, 0.1, 0);
    expect(r.before).toBe(0.5);
    expect(r.after).toBeCloseTo(0.6, 6);
    expect(r.appliedDelta).toBeCloseTo(0.1, 6);
    expect(r.requestedDelta).toBe(0.1);
    expect(r.budgetExceeded).toBe(false);
  });

  it('clamps the result to the [-1, 1] band', () => {
    const up = nudgeTopicWeight(0.95, 0.2, 0);
    expect(up.after).toBe(1);
    expect(up.appliedDelta).toBeCloseTo(0.05, 6);

    const down = nudgeTopicWeight(-0.95, -0.2, 0);
    expect(down.after).toBe(-1);
    expect(down.appliedDelta).toBeCloseTo(-0.05, 6);
  });

  it('applies nothing once the day budget is exhausted', () => {
    const atBudget = nudgeTopicWeight(0.5, -0.15, R.NUDGE_DAY_BUDGET);
    expect(atBudget.appliedDelta).toBe(0);
    expect(atBudget.after).toBe(0.5);
    expect(atBudget.budgetExceeded).toBe(true);

    const overBudget = nudgeTopicWeight(0.5, 0.1, 0.5);
    expect(overBudget.appliedDelta).toBe(0);
    expect(overBudget.budgetExceeded).toBe(true);
  });

  it('clamps a partial remaining budget', () => {
    // budget 0.3, already spent 0.25 → only 0.05 remains.
    const r = nudgeTopicWeight(0.5, -0.15, 0.25);
    expect(r.appliedDelta).toBeCloseTo(-0.05, 6);
    expect(r.after).toBeCloseTo(0.45, 6);
    expect(r.budgetExceeded).toBe(true);
  });
});
