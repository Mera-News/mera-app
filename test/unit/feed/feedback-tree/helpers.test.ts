import type { TFunction } from 'i18next';
import { pickMatchedFact } from '@/components/custom/feedback-tree/pick-fact';
import { summaryToast } from '@/components/custom/feedback-tree/answer-summary';
import { buildBugPrefill } from '@/components/custom/feedback-tree/bug-prefill';

const t = ((k: string, o?: Record<string, unknown>) =>
  o ? `${k}|${JSON.stringify(o)}` : k) as unknown as TFunction;

describe('pickMatchedFact', () => {
  it('picks the candidate holding the most of the story`s matched topic TEXTS, primary statement only', () => {
    const r = pickMatchedFact(
      [
        { id: 'a', statement: 'One', metadata: { topics: ['pensions India', 'cricket', 'tennis'] } },
        { id: 'b', statement: 'Two; Extra', metadata: { topics: ['pensions India', 'Bhopal news'] } },
      ],
      ['pensions India', 'Bhopal news'],
    );
    expect(r).toEqual({ id: 'b', statement: 'Two', topicTexts: ['pensions India', 'Bhopal news'] });
  });
  it('a tie, or a linked fact whose topics changed since, goes to the first candidate', () => {
    const facts = [
      { id: 'a', statement: 'One', metadata: { topics: ['old topic'] } },
      { id: 'b', statement: 'Two', metadata: { topics: ['other'] } },
    ];
    expect(pickMatchedFact(facts, ['Bhopal news'])?.id).toBe('a');
  });
  it('returns null with no candidates', () => {
    expect(pickMatchedFact([], ['Bhopal news'])).toBeNull();
  });
});

describe('summaryToast', () => {
  const c = { cause: 'config' as const };
  const s = { cause: 'system' as const };
  const o = { cause: 'source' as const };
  it('covers each case', () => {
    expect(summaryToast(t, [])).toBeNull();
    expect(summaryToast(t, [c, c, o])).toBe('feedbackTree.menu.toastChanges|{"count":2}');
    expect(summaryToast(t, [s])).toBe('feedbackTree.menu.toastMistakes|{"count":1}');
    expect(summaryToast(t, [c, s, s])).toBe(
      'feedbackTree.menu.toastBoth|{"changes":"feedbackTree.menu.toastChanges|{\\"count\\":1}","mistakes":"feedbackTree.menu.toastMistakeCount|{\\"count\\":2}"}',
    );
    expect(summaryToast(t, [o])).toBe('feedbackTree.menu.toastSaved');
  });
});

describe('buildBugPrefill', () => {
  const base = { reason: 'Wrong place', site: 'Example News', countryName: 'India', languageName: 'Hindi' };
  it('maps the scorer and joins four lines', () => {
    const phone = buildBugPrefill(t, { ...base, scorer: 'phone' }).split('\n');
    expect(phone).toHaveLength(4);
    expect(phone[3]).toContain('feedbackTree.menu.scorerPhone');
    expect(buildBugPrefill(t, { ...base, scorer: 'cloud' })).toContain('feedbackTree.menu.scorerCloud');
  });
  it('emits only the allowed fields, even if extra values are smuggled in', () => {
    const smuggled = {
      ...base,
      scorer: 'phone',
      articleId: 'abc123def',
      url: 'https://x.test/story',
      title: 'Secret Headline',
      factText: 'Lives in Atlantis',
      account: 'me@example.com',
    } as never;
    const out = buildBugPrefill(t, smuggled);
    for (const bad of ['abc123def', 'https://', 'Secret Headline', 'Atlantis', '@example.com']) {
      expect(out).not.toContain(bad);
    }
  });
});
