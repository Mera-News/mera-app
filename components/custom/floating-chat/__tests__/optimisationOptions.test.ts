import { genericOptionLabel } from '../plan-option-label';

const t = ((key: string) => `T(${key})`);

describe('plan option labels', () => {
  it("the service's generic Apply and Skip render through i18n keys", () => {
    expect(genericOptionLabel({ label: 'Apply', action: 'apply' }, t)).toBe('T(optimisationPlan.optionApply)');
    expect(genericOptionLabel({ label: 'Skip', action: 'skip' }, t)).toBe('T(optimisationPlan.optionSkip)');
  });

  it('LLM-written labels stay on the runtime path', () => {
    expect(genericOptionLabel({ label: 'Add football', action: 'apply' }, t)).toBeNull();
    expect(genericOptionLabel({ label: 'Apply', action: 'alternative' }, t)).toBeNull();
  });
});
