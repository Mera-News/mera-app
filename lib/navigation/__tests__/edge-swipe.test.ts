import {
  EDGE_SWIPE_HITBOX_WIDTH,
  EDGE_SWIPE_SAFE_RIGHT_INSET,
} from '../edge-swipe';

describe('edge-swipe geometry', () => {
  // The invariant the Saved sub-tab's delete button rests on: a control placed
  // at EDGE_SWIPE_SAFE_RIGHT_INSET must sit entirely OUTSIDE the Dashboard's
  // right-edge gesture strip, which swallows every tap that lands inside it.
  // Shrinking the inset back to (or below) the strip width would silently make
  // that button unpressable again.
  it('keeps the safe inset strictly clear of the hitbox', () => {
    expect(EDGE_SWIPE_SAFE_RIGHT_INSET).toBeGreaterThan(EDGE_SWIPE_HITBOX_WIDTH);
  });

  it('keeps the hitbox narrow enough to be a screen-edge gesture, not a gutter', () => {
    expect(EDGE_SWIPE_HITBOX_WIDTH).toBeGreaterThan(0);
    expect(EDGE_SWIPE_HITBOX_WIDTH).toBeLessThanOrEqual(24);
  });
});
