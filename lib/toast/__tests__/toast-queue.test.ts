/**
 * The toast queue's ORDERING and TIMING rules, which are the whole of "they go
 * away one by one" and are invisible to a render test: nothing here mounts a
 * component, so a regression in the deck's paint cannot make these pass.
 */
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), captureException: jest.fn() },
}));

import {
    TOAST_MIN_DURATION_MS,
    TOAST_QUEUE_CAP,
    close,
    closeAll,
    isActive,
    resetToastQueue,
    show,
    useToastQueue,
} from '../toast-queue';

const render = () => null;
const ids = (placement: 'top' | 'bottom' = 'top') =>
    useToastQueue.getState()[placement].map((entry) => entry.id);

beforeEach(() => {
    jest.useFakeTimers();
    resetToastQueue();
});

afterEach(() => {
    closeAll();
    jest.useRealTimers();
});

describe('order', () => {
    it('is FIFO: the oldest card holds the front slot', () => {
        const first = show({ render });
        const second = show({ render });
        const third = show({ render });
        expect(ids()).toEqual([first, second, third]);
    });

    it('keeps top and bottom as separate decks', () => {
        const top = show({ render });
        const bottom = show({ placement: 'bottom', render });
        expect(ids('top')).toEqual([top]);
        expect(ids('bottom')).toEqual([bottom]);
    });

    it('sorts a persistent card behind every transient one', () => {
        const banner = show({ duration: null, render });
        expect(ids()).toEqual([banner]);
        const transient = show({ render });
        // The banner gives up the front slot rather than deadlocking the queue.
        expect(ids()).toEqual([transient, banner]);
    });
});

describe('timers', () => {
    it('only times the FRONT card, and starts its clock on promotion', () => {
        const first = show({ duration: 1000, render });
        const second = show({ duration: 1000, render });

        jest.advanceTimersByTime(999);
        expect(ids()).toEqual([first, second]);

        jest.advanceTimersByTime(1);
        // The second card did NOT expire alongside it: its clock starts now.
        expect(ids()).toEqual([second]);

        jest.advanceTimersByTime(999);
        expect(ids()).toEqual([second]);
        jest.advanceTimersByTime(1);
        expect(ids()).toEqual([]);
    });

    it('lets a lone card run its full duration', () => {
        show({ duration: 5000, render });
        jest.advanceTimersByTime(4999);
        expect(ids()).toHaveLength(1);
        jest.advanceTimersByTime(1);
        expect(ids()).toHaveLength(0);
    });

    it('clamps the front card to the floor once something is waiting', () => {
        show({ duration: 5000, render });
        const waiting = show({ duration: 5000, render });

        jest.advanceTimersByTime(TOAST_MIN_DURATION_MS);
        expect(ids()).toEqual([waiting]);
    });

    it('clamps from when the card STARTED, never restarting its clock', () => {
        show({ duration: 5000, render });
        // 1500ms in, a second card arrives and cuts the promise to 2000ms
        // total. 500ms of that is left, not a fresh 2000.
        jest.advanceTimersByTime(1500);
        const waiting = show({ duration: 5000, render });
        jest.advanceTimersByTime(500);
        expect(ids()).toEqual([waiting]);
    });

    it('exempts holdFullDuration from the clamp', () => {
        const held = show({ duration: 5000, holdFullDuration: true, render });
        show({ duration: 5000, render });

        jest.advanceTimersByTime(4999);
        expect(ids()[0]).toBe(held);
        jest.advanceTimersByTime(1);
        expect(ids()[0]).not.toBe(held);
    });

    it('never times a persistent card, even alone at the front', () => {
        const banner = show({ duration: null, render });
        jest.advanceTimersByTime(60_000);
        expect(ids()).toEqual([banner]);
    });

    it('promotes a persistent card to the front once the transients drain', () => {
        const banner = show({ duration: null, render });
        show({ duration: 1000, render });
        jest.advanceTimersByTime(1000);
        expect(ids()).toEqual([banner]);
        jest.advanceTimersByTime(60_000);
        expect(ids()).toEqual([banner]);
    });
});

describe('cap', () => {
    it('drops the oldest WAITING card, keeping the front and the newest', () => {
        const queued = Array.from({ length: TOAST_QUEUE_CAP }, () =>
            show({ duration: 5000, render }),
        );
        expect(ids()).toEqual(queued);

        const newest = show({ duration: 5000, render });
        const after = ids();
        expect(after).toHaveLength(TOAST_QUEUE_CAP);
        // The card being read survives, so does the event just triggered.
        expect(after[0]).toBe(queued[0]);
        expect(after).toContain(newest);
        expect(after).not.toContain(queued[1]);
    });
});

describe('close', () => {
    it('removes a BURIED card, which never owned a timer', () => {
        const front = show({ duration: 5000, render });
        const buried = show({ duration: 5000, render });

        close(buried);
        expect(ids()).toEqual([front]);
        expect(isActive(buried)).toBe(false);
        expect(isActive(front)).toBe(true);
    });

    it('removes a persistent card from the back of the queue', () => {
        const banner = show({ id: 'banner', duration: null, render });
        show({ duration: 5000, render });
        expect(ids()[1]).toBe(banner);

        close(banner);
        expect(isActive(banner)).toBe(false);
    });

    it('promotes the next card and arms its timer', () => {
        const front = show({ duration: 5000, render });
        const next = show({ duration: 1000, render });

        close(front);
        expect(ids()).toEqual([next]);
        jest.advanceTimersByTime(1000);
        expect(ids()).toEqual([]);
    });

    it('closeAll empties every placement', () => {
        show({ render });
        show({ placement: 'bottom', render });
        closeAll();
        expect(ids('top')).toEqual([]);
        expect(ids('bottom')).toEqual([]);
    });
});

describe('caller-supplied ids', () => {
    it('replaces the existing card instead of queueing a duplicate', () => {
        show({ id: 'banner', duration: null, render });
        show({ id: 'banner', duration: null, render });
        expect(ids()).toEqual(['banner']);
    });

    it('reports isActive for a card it minted itself', () => {
        const id = show({ duration: 5000, render });
        expect(isActive(id)).toBe(true);
        jest.advanceTimersByTime(5000);
        expect(isActive(id)).toBe(false);
    });
});
