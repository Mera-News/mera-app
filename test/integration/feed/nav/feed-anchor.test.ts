import { ANCHOR_MIN_FRAMES, anchorStep, firstOnScreenId, type AnchorLand } from '@/components/custom/feed/feed-anchor';

const order = ['a', 'b', 'c', 'd'];
const fresh = (): AnchorLand => ({ issuedFor: null, prev: null, frames: 0 });

describe('firstOnScreenId', () => {
  it('is the topmost rendered row on screen', () => {
    expect(firstOnScreenId(order, new Set(['c', 'b']))).toBe('b');
  });
  it('ignores ids not rendered and is null when none', () => {
    expect(firstOnScreenId(order, new Set(['zz']))).toBeNull();
    expect(firstOnScreenId(order, new Set())).toBeNull();
  });
});

describe('anchorStep', () => {
  it('is pending while the list warms up, even for a missing id', () => {
    expect(anchorStep(false, [], 'x', 0, fresh())).toEqual({ result: 'pending', scrollToIndex: null });
  });
  it('is missing when the id is not in the list', () => {
    expect(anchorStep(true, order, 'x', 0, fresh()).result).toBe('missing');
  });
  it('re-issues the scroll every frame until two equal offsets settle it', () => {
    const land = fresh();
    expect(anchorStep(true, order, 'c', 0, land)).toEqual({ result: 'pending', scrollToIndex: 2 });
    // A far row: the first scrollToIndex failed and the list's retry landed it with no header offset.
    expect(anchorStep(true, order, 'c', 500, land)).toEqual({ result: 'pending', scrollToIndex: 2 });
    expect(anchorStep(true, order, 'c', 640, land)).toEqual({ result: 'pending', scrollToIndex: 2 });
    expect(anchorStep(true, order, 'c', 640, land).result).toBe('done');
  });

  it('does not take the old place for settled before the scroll reaches JS', () => {
    const land = fresh();
    for (let i = 0; i < ANCHOR_MIN_FRAMES; i++) expect(anchorStep(true, order, 'c', 0, land).result).toBe('pending');
  });
});
