// The on-device article chat sees the v6 sheet's answers, the screen and recent "Mera's mistake"
// reports as plain context lines, and nothing when they are absent.
import { articleChatContext, type ArticleChatContext } from '@/lib/news-harness/on-device/article-feedback';

const base: ArticleChatContext = {
  today: '2026-10-27',
  title: 'A title',
  matchedTopics: [],
  producingFacts: [],
  relatedCoverage: [],
};

describe('article chat feedback context', () => {
  it('renders answers by cause, the screen and the mistakes', () => {
    const text = articleChatContext({
      ...base,
      answers: ['Too much of this: Show less (applied)', 'Why this story (Mera\'s mistake, changes nothing)'],
      screen: 'Feed',
      mistakes: ['Not about my topic; story from Daily News, NL, nl'],
    });
    expect(text).toContain('- Too much of this: Show less (applied)');
    expect(text).toContain("- Why this story (Mera's mistake, changes nothing)");
    expect(text).toContain('Feed');
    expect(text).toContain('- Not about my topic; story from Daily News, NL, nl');
  });

  it('shows at most 3 mistakes', () => {
    const text = articleChatContext({ ...base, mistakes: ['m1', 'm2', 'm3', 'm4'] });
    expect(text).toContain('m3');
    expect(text).not.toContain('m4');
  });

  it('adds nothing when absent', () => {
    const text = articleChatContext(base);
    expect(text).not.toMatch(/answers|screen|mistake/i);
  });
});
