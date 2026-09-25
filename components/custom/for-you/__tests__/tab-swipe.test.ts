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

// Owner (ux2 B3): cache and warm one screen each side; the ends only one.
describe('swipeWindow: the mounted panels, active first', () => {
    const { swipeWindow } = require('../tab-swipe');

    it('mounts the active panel and one neighbour each side', () => {
        expect(swipeWindow(2, 5)).toEqual([2, 1, 3]);
    });

    it('mounts only the one existing neighbour at either end', () => {
        expect(swipeWindow(0, 5)).toEqual([0, 1]);
        expect(swipeWindow(4, 5)).toEqual([4, 3]);
    });

    it('never mounts more than 3, for any index and count', () => {
        for (let count = 0; count <= 8; count++) {
            for (let i = 0; i < Math.max(count, 1); i++) {
                const w = swipeWindow(i, count);
                expect(w.length).toBeLessThanOrEqual(3);
                for (const j of w) expect(j >= 0 && j < count).toBe(true);
            }
        }
    });

    it('a single tab mounts just itself, and no tabs mount nothing', () => {
        expect(swipeWindow(0, 1)).toEqual([0]);
        expect(swipeWindow(0, 0)).toEqual([]);
    });
});
