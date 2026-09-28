/**
 * The navigation scenario this scheduler exists for, stated as the owner stated
 * it: ten titles queued on the Feed, three translated, the user opens a story.
 * The remaining seven must be discarded IMMEDIATELY -- not lazily skipped when
 * they eventually reach the head -- and the new screen's text must be the very
 * next thing dispatched.
 *
 * These are deliberately end-to-end over the real module rather than unit tests
 * of `bumpTranslationEpoch`, because the property that matters is the
 * interaction: sweep-on-bump, then dispatch order, then the one uncancellable
 * call in flight.
 */
import {
    DROPPED,
    __resetTranslationQueueForTests,
    bumpTranslationEpoch,
    enqueueTranslationTask,
    getTranslationQueueStats,
    isDropped,
    visibilityPriority,
} from '@/lib/translation-queue';

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), warn: jest.fn(), captureException: jest.fn() },
}));

/** A controllable native call: resolves only when `finish()` is invoked. */
function deferred() {
    let finish!: (v?: unknown) => void;
    const promise = new Promise((resolve) => {
        finish = resolve as (v?: unknown) => void;
    });
    return { promise, finish };
}

const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
};

beforeEach(() => {
    __resetTranslationQueueForTests();
});

describe('leaving a screen mid-queue', () => {
    it('discards the untranslated remainder the instant the route changes', async () => {
        // Ten Feed titles. Concurrency is 1, so exactly one is in flight and
        // nine sit pending.
        const gates = Array.from({ length: 10 }, () => deferred());
        const results = gates.map((g, i) =>
            enqueueTranslationTask(() => g.promise as Promise<unknown>, {
                priority: visibilityPriority(i * 100),
                label: `feed-title-${i}`,
            }),
        );
        await flush();

        // Let three complete, mirroring "translated only 3 of 10".
        gates[0].finish('t0');
        await flush();
        gates[1].finish('t1');
        await flush();
        gates[2].finish('t2');
        await flush();

        const beforeNav = getTranslationQueueStats();
        expect(beforeNav.completed).toBe(3);
        expect(beforeNav.inFlight).toBe(1); // #4 already started -- uncancellable
        expect(beforeNav.pending).toBe(6); // #5..#10 never started

        // The user navigates.
        bumpTranslationEpoch('/logged-in/news-detail/abc');

        // The six that had not started are gone from the queue ALREADY, before
        // anything else runs and without waiting to reach the head.
        const afterNav = getTranslationQueueStats();
        expect(afterNav.pending).toBe(0);
        expect(afterNav.dropped).toBe(6);

        await flush();
        const settled = await Promise.all(results.slice(4));
        expect(settled.every(isDropped)).toBe(true);
        expect(settled).toEqual(Array(6).fill(DROPPED));

        // A drop is NOT a failure: no promise rejected, so no caller can mark
        // this text permanently un-translatable.
        await expect(Promise.all(results.slice(4))).resolves.toBeDefined();
    });

    it('dispatches the new screen next, as soon as the uncancellable call ends', async () => {
        const feed = Array.from({ length: 10 }, () => deferred());
        feed.forEach((g, i) =>
            enqueueTranslationTask(() => g.promise as Promise<unknown>, {
                priority: visibilityPriority(i * 100),
                label: `feed-title-${i}`,
            }),
        );
        await flush();

        bumpTranslationEpoch('/logged-in/news-detail/abc');
        await flush();

        // The story title, enqueued by the screen the user is now looking at.
        const story = deferred();
        const dispatched: string[] = [];
        const storyResult = enqueueTranslationTask(
            () => {
                dispatched.push('story-title');
                return story.promise as Promise<unknown>;
            },
            { priority: visibilityPriority(0), label: 'story-title' },
        );
        await flush();

        // Still blocked ONLY by the single in-flight Feed call -- one call's
        // latency, not nine.
        expect(dispatched).toEqual([]);
        expect(getTranslationQueueStats().inFlight).toBe(1);

        feed[0].finish('t0');
        await flush();

        expect(dispatched).toEqual(['story-title']);
        story.finish('story!');
        await expect(storyResult).resolves.toBe('story!');
    });

    it('re-enqueues nothing from the abandoned screen when it comes back to it', async () => {
        // Going back bumps the epoch again; items dropped on the way out are
        // already gone, so the return trip starts clean rather than replaying a
        // backlog the user has moved past twice.
        const g = deferred();
        const dropped = enqueueTranslationTask(() => g.promise as Promise<unknown>, {
            label: 'a',
        });
        const queued = enqueueTranslationTask(async () => 'b', { label: 'b' });
        await flush();

        bumpTranslationEpoch('/detail');
        await flush();
        bumpTranslationEpoch('/feed');
        await flush();

        expect(await queued).toBe(DROPPED);
        expect(getTranslationQueueStats().pending).toBe(0);
        // The one that had already started still resolves normally.
        g.finish('a!');
        await expect(dropped).resolves.toBe('a!');
    });

    it('never drops the language-availability probe, which is epoch-exempt', async () => {
        const probe = enqueueTranslationTask(async () => 'probe-ok', {
            epoch: null,
            priority: -1_000_000,
            label: 'probe',
        });
        const title = enqueueTranslationTask(async () => 'title', { label: 'title' });
        await flush();

        bumpTranslationEpoch('/somewhere');
        await flush();

        expect(await probe).toBe('probe-ok');
        expect(await title).not.toBe(DROPPED);
    });
});
