// The translation scheduler — ordering, route-epoch dropping, and the
// probe exemption. These are the three behaviours the latency fix rests on.

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));
// The scroll-tick generation stamps "became visible": rows that came into view
// in the same tick share it and then sort top-to-bottom.
let mockGeneration = 0;
jest.mock('@/lib/visibility-tick', () => ({ getScrollTickGeneration: () => mockGeneration }));

import {
    __resetTranslationQueueForTests,
    bumpTranslationEpoch,
    DROPPED,
    enqueueTranslationTask,
    getTranslationEpoch,
    getTranslationQueueStats,
    isDropped,
    PROBE_PRIORITY,
    subscribeTranslationEpoch,
    scheduleTranslationTask,
    TRANSLATION_CONCURRENCY,
} from '../translation-queue';

/** A task that resolves only when its returned `release` is called. */
function deferredTask<T>(value: T) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let started = false;
    const run = async () => {
        started = true;
        await gate;
        return value;
    };
    return { run, release, hasStarted: () => started };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
    __resetTranslationQueueForTests();
    mockGeneration = 0;
});

describe('concurrency', () => {
    it('is one — the OS cancels concurrent translation sessions', () => {
        expect(TRANSLATION_CONCURRENCY).toBe(1);
    });

    it('runs exactly one task at a time', async () => {
        const a = deferredTask('a');
        const b = deferredTask('b');
        void enqueueTranslationTask(a.run);
        void enqueueTranslationTask(b.run);
        await flush();

        expect(a.hasStarted()).toBe(true);
        expect(b.hasStarted()).toBe(false);
        expect(getTranslationQueueStats().inFlight).toBe(1);

        a.release();
        await flush();
        expect(b.hasStarted()).toBe(true);
    });
});

describe('priority ordering', () => {
    it('dispatches the lowest-priority-number item first, not the earliest', async () => {
        const head = deferredTask('head');
        void enqueueTranslationTask(head.run); // occupies the single slot
        await flush();

        const order: string[] = [];
        void enqueueTranslationTask(async () => {
            order.push('bottom-of-screen');
        }, { priority: 900 });
        void enqueueTranslationTask(async () => {
            order.push('top-of-screen');
        }, { priority: 10 });
        void enqueueTranslationTask(async () => {
            order.push('scrolled-past');
        }, { priority: 100_050 });

        head.release();
        await flush();
        await flush();
        await flush();

        expect(order).toEqual(['top-of-screen', 'bottom-of-screen', 'scrolled-past']);
    });

    it('breaks priority ties by enqueue order', async () => {
        const head = deferredTask('head');
        void enqueueTranslationTask(head.run);
        await flush();

        const order: string[] = [];
        void enqueueTranslationTask(async () => { order.push('first'); }, { priority: 5 });
        void enqueueTranslationTask(async () => { order.push('second'); }, { priority: 5 });

        head.release();
        await flush();
        await flush();

        expect(order).toEqual(['first', 'second']);
    });
});

describe('route epoch', () => {
    it('drops queued items stamped with an older epoch, without running them', async () => {
        const head = deferredTask('head');
        void enqueueTranslationTask(head.run);
        await flush();

        const stale = jest.fn(async () => 'stale');
        const result = enqueueTranslationTask(stale);

        bumpTranslationEpoch('/logged-in/article/1');

        await expect(result).resolves.toBe(DROPPED);
        head.release();
        await flush();
        await flush();
        expect(stale).not.toHaveBeenCalled();
    });

    it('resolves a drop rather than rejecting it', async () => {
        const head = deferredTask('head');
        void enqueueTranslationTask(head.run);
        await flush();

        const result = enqueueTranslationTask(async () => 'x');
        bumpTranslationEpoch();
        const value = await result;
        expect(isDropped(value)).toBe(true);
    });

    it('keeps items enqueued AFTER the bump', async () => {
        const head = deferredTask('head');
        void enqueueTranslationTask(head.run);
        await flush();

        bumpTranslationEpoch();
        const fresh = jest.fn(async () => 'fresh');
        const result = enqueueTranslationTask(fresh);

        head.release();
        await flush();
        await flush();

        await expect(result).resolves.toBe('fresh');
        expect(fresh).toHaveBeenCalled();
    });

    it('cannot stop a task that already started — it only prevents dispatch', async () => {
        const running = deferredTask('running');
        const result = enqueueTranslationTask(running.run);
        await flush();
        expect(running.hasStarted()).toBe(true);

        bumpTranslationEpoch();
        running.release();

        await expect(result).resolves.toBe('running');
    });

    it('advances the epoch counter and notifies subscribers', () => {
        const listener = jest.fn();
        const unsubscribe = subscribeTranslationEpoch(listener);
        const before = getTranslationEpoch();
        const after = bumpTranslationEpoch();
        expect(after).toBe(before + 1);
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        bumpTranslationEpoch();
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('counts drops in the queue stats so the behaviour is observable', async () => {
        const head = deferredTask('head');
        void enqueueTranslationTask(head.run);
        await flush();
        void enqueueTranslationTask(async () => 'a');
        void enqueueTranslationTask(async () => 'b');
        bumpTranslationEpoch();
        expect(getTranslationQueueStats().dropped).toBe(2);
        expect(getTranslationQueueStats().pending).toBe(0);
        head.release();
        await flush();
    });
});

describe('epoch-exempt items (the probe)', () => {
    it('survives a route change that drops everything else', async () => {
        const head = deferredTask('head');
        void enqueueTranslationTask(head.run);
        await flush();

        const ordinary = enqueueTranslationTask(async () => 'ordinary');
        const probe = enqueueTranslationTask(async () => 'probe', {
            epoch: null,
            priority: PROBE_PRIORITY,
        });

        bumpTranslationEpoch();
        head.release();
        await flush();
        await flush();

        await expect(ordinary).resolves.toBe(DROPPED);
        await expect(probe).resolves.toBe('probe');
    });

    it('runs ahead of a screenful of headlines', async () => {
        const head = deferredTask('head');
        void enqueueTranslationTask(head.run);
        await flush();

        const order: string[] = [];
        for (let i = 0; i < 5; i++) {
            void enqueueTranslationTask(async () => { order.push(`title-${i}`); }, { priority: i });
        }
        void enqueueTranslationTask(async () => { order.push('probe'); }, {
            epoch: null,
            priority: PROBE_PRIORITY,
        });

        head.release();
        for (let i = 0; i < 8; i++) await flush();

        expect(order[0]).toBe('probe');
    });
});

describe('failure propagation', () => {
    it('rejects the caller when the task rejects, and keeps draining', async () => {
        const boom = enqueueTranslationTask(async () => {
            throw new Error('native blew up');
        });
        await expect(boom).rejects.toThrow('native blew up');

        await expect(enqueueTranslationTask(async () => 'next')).resolves.toBe('next');
    });

    it('rejects the caller when the task throws synchronously', async () => {
        const boom = enqueueTranslationTask((() => {
            throw new Error('sync blow up');
        }) as () => Promise<string>);
        await expect(boom).rejects.toThrow('sync blow up');
        await expect(enqueueTranslationTask(async () => 'next')).resolves.toBe('next');
    });
});

// ── ux2: handles, visible-first ranking, and the slot held for native ──────

describe('handles', () => {
    it('cancel() drops a queued item: it never runs and resolves DROPPED', async () => {
        const head = deferredTask('head');
        void enqueueTranslationTask(head.run);
        await flush();
        const ran = jest.fn(async () => 'x');
        const h = scheduleTranslationTask(ran);
        expect(h.cancel()).toBe(true);
        head.release();
        await flush();
        await expect(h.promise).resolves.toBe(DROPPED);
        expect(ran).not.toHaveBeenCalled();
        expect(getTranslationQueueStats().pending).toBe(0);
    });

    it('cancel() cannot stop a dispatched item', async () => {
        const a = deferredTask('a');
        const h = scheduleTranslationTask(a.run);
        await flush();
        expect(h.cancel()).toBe(false);
        a.release();
        await expect(h.promise).resolves.toBe('a');
    });
});

describe('visible-first ranking', () => {
    type Push = (
        label: string,
        rank?: { visible: boolean; y: number },
        extra?: { epoch?: number | null; priority?: number },
    ) => ReturnType<typeof scheduleTranslationTask>;
    async function order(setup: (push: Push) => void) {
        const head = deferredTask('head');
        void enqueueTranslationTask(head.run);
        await flush();
        const out: string[] = [];
        setup((label, rank, extra) =>
            scheduleTranslationTask(async () => { out.push(label); }, { ...(rank ? { rank } : {}), ...(extra ?? {}) }),
        );
        head.release();
        for (let i = 0; i < 10; i++) await flush();
        return out;
    }

    it('visible rows go before rows that left the screen', async () => {
        const out = await order((push) => {
            push('left', { visible: false, y: 10 });
            push('on-screen', { visible: true, y: 500 });
        });
        expect(out).toEqual(['on-screen', 'left']);
    });

    it('the most recently visible go first, then top to bottom', async () => {
        const out = await order((push) => {
            mockGeneration = 1;
            push('older-top', { visible: true, y: 10 });
            mockGeneration = 2;
            push('newer-bottom', { visible: true, y: 600 });
            push('newer-top', { visible: true, y: 100 });
        });
        expect(out).toEqual(['newer-top', 'newer-bottom', 'older-top']);
    });

    it('setPriority re-ranks a queued item: a row scrolled back into view jumps ahead', async () => {
        const out = await order((push) => {
            mockGeneration = 1;
            push('a', { visible: true, y: 10 });
            const b = push('b', { visible: false, y: 0 });
            mockGeneration = 2;
            b.setPriority({ visible: true, y: 300 });
        });
        expect(out).toEqual(['b', 'a']);
    });

    it('staying visible keeps the stamp of when it BECAME visible', async () => {
        const out = await order((push) => {
            mockGeneration = 1;
            const a = push('a', { visible: true, y: 400 });
            mockGeneration = 2;
            push('b', { visible: true, y: 10 });
            a.setPriority({ visible: true, y: 5 }); // still visible: stamp stays 1
        });
        expect(out).toEqual(['b', 'a']);
    });

    it('the probe still goes first', async () => {
        const out = await order((push) => {
            mockGeneration = 5;
            push('row', { visible: true, y: 0 });
            push('probe', undefined, { epoch: null, priority: PROBE_PRIORITY });
        });
        expect(out).toEqual(['probe', 'row']);
    });
});

describe('the slot is held until the native call settles', () => {
    it('a task that returns early (a JS timeout) keeps the slot while its native call runs', async () => {
        let settleNative!: () => void;
        const native = new Promise<void>((r) => (settleNative = r));
        const first = scheduleTranslationTask(async (hold) => {
            hold(native, 60_000);
            return 'timed-out';
        });
        await expect(first.promise).resolves.toBe('timed-out');
        const second = jest.fn(async () => 'second');
        void scheduleTranslationTask(second);
        await flush();
        expect(second).not.toHaveBeenCalled();
        expect(getTranslationQueueStats().inFlight).toBe(1);
        settleNative();
        await flush();
        await flush();
        expect(second).toHaveBeenCalled();
    });

    it('a native call that never settles (a leaked continuation) frees the slot at the ceiling', async () => {
        jest.useFakeTimers();
        try {
            const first = scheduleTranslationTask(async (hold) => {
                hold(new Promise<void>(() => {}), 80_000);
                return 'gave-up';
            });
            await Promise.resolve();
            await Promise.resolve();
            await first.promise;
            const second = jest.fn(async () => 'second');
            void scheduleTranslationTask(second);
            await Promise.resolve();
            expect(second).not.toHaveBeenCalled();
            jest.advanceTimersByTime(80_000);
            for (let i = 0; i < 5; i++) await Promise.resolve();
            expect(second).toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });
});
