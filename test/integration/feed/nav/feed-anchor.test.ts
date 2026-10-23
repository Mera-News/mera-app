import { anchorStep, firstOnScreenId, type AnchorLand } from '@/components/custom/feed/feed-anchor';

const order = ['a', 'b', 'c', 'd'];
const fresh = (): AnchorLand => ({ issuedFor: null, prev: null });

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
  it('scrolls once, then is done after two equal offsets', () => {
    const land = fresh();
    expect(anchorStep(true, order, 'c', 0, land)).toEqual({ result: 'pending', scrollToIndex: 2 });
    expect(anchorStep(true, order, 'c', 500, land)).toEqual({ result: 'pending', scrollToIndex: null });
    expect(anchorStep(true, order, 'c', 640, land).result).toBe('pending');
    expect(anchorStep(true, order, 'c', 640, land).result).toBe('done');
  });
});
