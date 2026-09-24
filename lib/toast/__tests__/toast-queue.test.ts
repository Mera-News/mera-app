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
const ids = () => useToastQueue.getState().entries.map((entry) => entry.id);

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

    it('has ONE stack: there is no bottom lane', () => {
        expect(Object.keys(useToastQueue.getState())).toEqual(['entries']);
    });

    it("joins a stray 'bottom' placement to the one stack, behind the card showing", () => {
        const showing = show({ render });
        const stray = show({ placement: 'bottom', render });
        expect(ids()).toEqual([showing, stray]);
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

    it('keeps the front card for its OWN full duration while others wait (owner rule)', () => {
        // The device repro: a 6s toast, then a second one 4.3s into it. The
        // front used to be clamped to a 2s floor measured from its start, so
        // it left the instant the second arrived.
        const front = show({ duration: 6000, render });
        jest.advanceTimersByTime(4300);
        const waiting = show({ duration: 6000, render });
        expect(ids()).toEqual([front, waiting]);

        jest.advanceTimersByTime(1699);
        expect(ids()).toEqual([front, waiting]);
        jest.advanceTimersByTime(1);
        expect(ids()).toEqual([waiting]);
    });

    it('never shortens the front card however many arrive behind it', () => {
        const front = show({ duration: 5000, render });
        for (let i = 0; i < 4; i += 1) show({ duration: 5000, render });
        jest.advanceTimersByTime(4999);
        expect(ids()[0]).toBe(front);
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

    it('closeAll empties the stack', () => {
        show({ render });
        show({ placement: 'bottom', render });
        closeAll();
        expect(ids()).toEqual([]);
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
