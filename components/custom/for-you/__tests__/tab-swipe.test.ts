// ux2 B3: swipe left/right between tabs (Dashboard pills, Explore scopes).
// The decision is pure: where a finished drag lands, given its distance and
// velocity, the current tab, the tab count and the writing direction.
import {
    TAB_SWIPE_COMMIT_FRACTION,
    TAB_SWIPE_COMMIT_VELOCITY,
    TAB_SWIPE_DAMPING,
    swipeTarget,
} from '../tab-swipe';

const W = 400;
const at = (dx: number, vx = 0, index = 2, count = 5, rtl = false) =>
    swipeTarget({ dx, vx, width: W, index, count, rtl });

describe('swipeTarget', () => {
    it('commits past ~30% of the width, or on a fast flick', () => {
        expect(TAB_SWIPE_COMMIT_FRACTION).toBeCloseTo(0.3);
        expect(TAB_SWIPE_COMMIT_VELOCITY).toBe(600);
        // The drag is damped, so the finger travels further than the panel.
        const committing = (W * TAB_SWIPE_COMMIT_FRACTION) / TAB_SWIPE_DAMPING + 1;
        expect(at(-committing)).toBe(3);
        expect(at(committing)).toBe(1);
        expect(at(-20, -700)).toBe(3);
        expect(at(20, 700)).toBe(1);
    });

    it('springs back on a short, slow drag', () => {
        expect(at(-40, -100)).toBeNull();
        expect(at(40, 100)).toBeNull();
    });

    it('has nowhere to go past either end', () => {
        expect(at(-400, -1000, 4, 5)).toBeNull();
        expect(at(400, 1000, 0, 5)).toBeNull();
    });

    it('does not let a flick against the drag decide the direction', () => {
        // Dragged left far, then flicked right: the flick wins only by speed,
        // and a flick against a big drag is ambiguous, so it springs back.
        expect(at(-300, 700)).toBeNull();
    });

    it('mirrors in RTL: a leftward swipe goes to the PREVIOUS tab', () => {
        const committing = (W * TAB_SWIPE_COMMIT_FRACTION) / TAB_SWIPE_DAMPING + 1;
        expect(at(-committing, 0, 2, 5, true)).toBe(1);
        expect(at(committing, 0, 2, 5, true)).toBe(3);
    });
});
