import { sanitizeSnapshots } from '@/lib/algorithms/tracked-story-snapshots';

describe('sanitizeSnapshots: storyKey', () => {
  it('keeps a string storyKey and drops anything else', () => {
    const [kept, dropped] = sanitizeSnapshots([
      { articleId: 'a', title: 't', pubDateMs: 1, storyKey: 'K' },
      { articleId: 'b', title: 't', pubDateMs: 1, storyKey: 7 },
    ]);
    expect(kept.storyKey).toBe('K');
    expect(dropped.storyKey).toBeUndefined();
  });
});
