import { LANDING_MS, LANDING_STAGGER_MS, landingPlan } from '@/components/custom/floating-chat/landing';

const done = (id: string) => ({ id, status: 'done' as const });

describe('landingPlan', () => {
  it('lands new done rows 120 ms apart and rests the strip until the last one ends', () => {
    const plan = landingPlan(new Set(['leg']), [done('leg'), done('a'), done('b'), done('c')]);
    expect([...plan.delays]).toEqual([['a', 0], ['b', LANDING_STAGGER_MS], ['c', 2 * LANDING_STAGGER_MS]]);
    expect(plan.totalMs).toBe(LANDING_MS + 2 * LANDING_STAGGER_MS);
  });

  it('never replays a row in the baseline (a reopened chat or fold shows ticks only)', () => {
    const plan = landingPlan(new Set(['a', 'b']), [done('a'), done('b')]);
    expect(plan.delays.size).toBe(0);
    expect(plan.totalMs).toBe(0);
  });

  it('a pending or failed row does not land', () => {
    const plan = landingPlan(new Set(), [{ id: 'p', status: 'pending' }, { id: 'e', status: 'error' }]);
    expect(plan.delays.size).toBe(0);
  });
});
