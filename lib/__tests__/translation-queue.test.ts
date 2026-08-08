// The translation scheduler — ordering, route-epoch dropping, and the
// probe exemption. These are the three behaviours the latency fix rests on.

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

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
    TRANSLATION_CONCURRENCY,
    visibilityPriority,
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
});

describe('visibilityPriority', () => {
    it('is the measured y for anything at or below the top of the viewport', () => {
        expect(visibilityPriority(0)).toBe(0);
        expect(visibilityPriority(240)).toBe(240);
    });

    it('ranks a node higher up the screen ahead of one lower down', () => {
        expect(visibilityPriority(100)).toBeLessThan(visibilityPriority(600));
    });

    it('sorts scrolled-past nodes behind everything on screen, furthest last', () => {
        const above = visibilityPriority(-50);
        const wayAbove = visibilityPriority(-800);
        expect(above).toBeGreaterThan(visibilityPriority(2000));
        expect(wayAbove).toBeGreaterThan(above);
    });

    it('never yields NaN for a degenerate measurement', () => {
        expect(visibilityPriority(Number.NaN)).toBe(0);
    });
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
