import { formatKnownFacts } from '@/lib/mera-harness/core/core';

describe('formatKnownFacts places', () => {
  it('appends the places after the statement when set', () => {
    const out = formatKnownFacts([{ id: 'a', statement: 'Lives in Pune', attribute: 'home', places: 'India; Pune' }]);
    expect(out).toBe("- [a] 'home': Lives in Pune (news from: India; Pune)");
  });
  it('adds nothing when absent', () => {
    const out = formatKnownFacts([{ id: 'a', statement: 'Lives in Pune' }]);
    expect(out).toBe("- [a] 'other': Lives in Pune");
  });
});
