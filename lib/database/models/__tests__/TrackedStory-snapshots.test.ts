// The member-snapshot sanitiser keeps the original-language title (ux2), and
// old snapshots without it still read.

import { sanitizeSnapshots } from '../TrackedStory';

describe('sanitizeSnapshots', () => {
  it('keeps titleOriginal', () => {
    const [s] = sanitizeSnapshots([{ articleId: 'a', title: 'Tokyo rain', titleOriginal: '東京で雨', pubDateMs: 1 }]);
    expect(s.titleOriginal).toBe('東京で雨');
    expect(s.title).toBe('Tokyo rain');
  });

  it('reads a snapshot written before the field existed, and drops an empty one', () => {
    const [old, empty] = sanitizeSnapshots([
      { articleId: 'a', title: 'Tokyo rain', pubDateMs: 1 },
      { articleId: 'b', title: 'x', titleOriginal: '', pubDateMs: 1 },
    ]);
    expect(old.titleOriginal).toBeUndefined();
    expect(empty.titleOriginal).toBeUndefined();
  });
});
