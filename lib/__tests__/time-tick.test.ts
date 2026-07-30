// time-tick — the ONE shared clock behind every relative-age label.
//
// What matters here is the lifecycle, not the arithmetic: exactly one interval
// for any number of subscribers, no interval at all when nothing is mounted or
// the app is backgrounded, and an immediate catch-up on foreground.
//
// `react-native` is replaced with a hand-rolled AppState so the spec can drive
// foreground/background transitions directly (the module touches nothing else
// from RN).

type Handler = (state: string) => void;

const mockAppState: { currentState: string; handlers: Set<Handler> } = {
    currentState: 'active',
    handlers: new Set(),
};

jest.mock('react-native', () => ({
    AppState: {
        get currentState() {
            return mockAppState.currentState;
        },
        addEventListener: (_event: string, handler: Handler) => {
            mockAppState.handlers.add(handler);
            return { remove: () => mockAppState.handlers.delete(handler) };
        },
    },
}));

// eslint-disable-next-line import/first
import {
    TIME_TICK_MS,
    __resetTimeTickForTests,
    getTimeTick,
    notifyTimeTick,
    subscribeTimeTick,
} from '../time-tick';

function emitAppState(state: string): void {
    mockAppState.currentState = state;
    mockAppState.handlers.forEach((h) => h(state));
}

describe('time-tick', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        mockAppState.currentState = 'active';
        mockAppState.handlers.clear();
        __resetTimeTickForTests();
    });

    afterEach(() => {
        __resetTimeTickForTests();
        jest.useRealTimers();
    });

    it('runs NO timer until something subscribes', () => {
        expect(jest.getTimerCount()).toBe(0);
    });

    it('advances the published clock once per tick', () => {
        const before = getTimeTick();
        const seen: number[] = [];
        subscribeTimeTick(() => seen.push(getTimeTick()));

        jest.advanceTimersByTime(TIME_TICK_MS);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toBeGreaterThanOrEqual(before + TIME_TICK_MS);

        jest.advanceTimersByTime(TIME_TICK_MS);
        expect(seen).toHaveLength(2);
    });

    it('shares ONE interval across many subscribers — never a timer per card', () => {
        const unsubs = Array.from({ length: 25 }, () => subscribeTimeTick(() => {}));
        expect(jest.getTimerCount()).toBe(1);
        unsubs.forEach((u) => u());
    });

    it('notifies every subscriber on a tick', () => {
        const a = jest.fn();
        const b = jest.fn();
        subscribeTimeTick(a);
        subscribeTimeTick(b);
        jest.advanceTimersByTime(TIME_TICK_MS);
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
    });

    it('stops the timer when the LAST subscriber leaves, and re-arms for a new one', () => {
        const unsubA = subscribeTimeTick(() => {});
        const unsubB = subscribeTimeTick(() => {});
        unsubA();
        expect(jest.getTimerCount()).toBe(1); // B still there
        unsubB();
        expect(jest.getTimerCount()).toBe(0); // nothing mounted → nothing ticking

        subscribeTimeTick(() => {});
        expect(jest.getTimerCount()).toBe(1);
    });

    it('does not notify an unsubscribed listener', () => {
        const gone = jest.fn();
        const unsub = subscribeTimeTick(gone);
        unsub();
        subscribeTimeTick(() => {}); // keep the store awake
        jest.advanceTimersByTime(TIME_TICK_MS * 3);
        expect(gone).not.toHaveBeenCalled();
    });

    it('refreshes the clock when waking from dormancy, so a first render is never stale', () => {
        const unsub = subscribeTimeTick(() => {});
        unsub();
        const dormantAt = getTimeTick();

        jest.advanceTimersByTime(TIME_TICK_MS * 10); // nothing ticks while dormant
        expect(getTimeTick()).toBe(dormantAt);

        subscribeTimeTick(() => {}); // waking re-reads the real clock
        expect(getTimeTick()).toBeGreaterThanOrEqual(dormantAt + TIME_TICK_MS * 10);
    });

    it('stops ticking while the app is backgrounded', () => {
        const listener = jest.fn();
        subscribeTimeTick(listener);
        emitAppState('background');
        expect(jest.getTimerCount()).toBe(0);

        jest.advanceTimersByTime(TIME_TICK_MS * 5);
        expect(listener).not.toHaveBeenCalled();
    });

    it('snaps forward IMMEDIATELY on return to the foreground, without waiting out a tick', () => {
        const listener = jest.fn();
        subscribeTimeTick(listener);
        emitAppState('background');
        jest.advanceTimersByTime(TIME_TICK_MS * 5);

        const beforeResume = getTimeTick();
        emitAppState('active');
        expect(listener).toHaveBeenCalledTimes(1);
        expect(getTimeTick()).toBeGreaterThanOrEqual(beforeResume + TIME_TICK_MS * 5);
        expect(jest.getTimerCount()).toBe(1);
    });

    it('does NOT re-arm on foreground when nothing is mounted any more', () => {
        const unsub = subscribeTimeTick(() => {});
        emitAppState('background');
        unsub(); // the last card went away while we were away
        emitAppState('active');
        expect(jest.getTimerCount()).toBe(0);
    });

    it('removes its AppState listener once the last subscriber leaves', () => {
        const unsub = subscribeTimeTick(() => {});
        expect(mockAppState.handlers.size).toBe(1);
        unsub();
        expect(mockAppState.handlers.size).toBe(0);
    });

    it('does not arm the interval when subscribing while backgrounded', () => {
        mockAppState.currentState = 'background';
        subscribeTimeTick(() => {});
        expect(jest.getTimerCount()).toBe(0);
    });

    it('notifyTimeTick() advances the clock on demand (the on-focus hook)', () => {
        const listener = jest.fn();
        subscribeTimeTick(listener);
        jest.advanceTimersByTime(1_000); // less than a tick
        expect(listener).not.toHaveBeenCalled();

        notifyTimeTick();
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('publishes nothing when the clock has not actually moved', () => {
        const listener = jest.fn();
        subscribeTimeTick(listener);
        notifyTimeTick();
        listener.mockClear();
        notifyTimeTick(); // same millisecond — no snapshot change, no re-render
        expect(listener).not.toHaveBeenCalled();
    });

    it('is safe to call with no subscribers at all', () => {
        expect(() => notifyTimeTick()).not.toThrow();
        expect(jest.getTimerCount()).toBe(0);
    });
});
