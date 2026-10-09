// The 10 minute cache TTL, the cacheEvictionLink that applies it on a network request, and the
// scheduler task that applies it from the foreground and a timer.
import { evictExpiredApolloCache } from '@/lib/apollo-client';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import type { TaskDefinition } from '@/lib/scheduler/scheduler-types';
import '@/lib/scheduler/tasks/apollo-cache-evict-task';
import { advanceUntilDone, mockGql, server, useFakeClock } from '@/test/helpers';
import { client, countOps, OTHER, PROBE, recordRequests, resetLinkState } from './kit';

const MIN = 60_000;

// lastCacheClear is module memory and only moves forward, so each test starts its clock hours
// after the previous one: a test must never begin before the stamp an earlier test left behind.
let clock = Date.now();
beforeEach(async () => {
    resetLinkState();
    await client.cache.reset(); // the cache is module memory too
    clock += 3 * 60 * MIN;
    useFakeClock(clock);
    server.use(mockGql('LinkProbe', { probe: 'v' }), mockGql('LinkOther', { other: 'v' }));
});
afterEach(() => AppScheduler.dispose());

const cached = () => client.query({ query: PROBE });
const flush = () => jest.advanceTimersByTimeAsync(50);

describe('the TTL', () => {
    it('serves a cache-first query from cache inside 10 minutes, even when eviction runs', async () => {
        const seen = recordRequests();
        await cached();
        await jest.advanceTimersByTimeAsync(9 * MIN);

        evictExpiredApolloCache();
        await cached();

        expect(await countOps(seen, 'LinkProbe')).toBe(1);
    });

    it('keeps serving the stale entry past the TTL until eviction runs, then goes to the network', async () => {
        const seen = recordRequests();
        await cached();
        await jest.advanceTimersByTimeAsync(11 * MIN);

        await cached();
        expect(await countOps(seen, 'LinkProbe')).toBe(1);

        evictExpiredApolloCache();
        await flush();
        await cached();

        expect(await countOps(seen, 'LinkProbe')).toBe(2);
    });

    it('a network request for another operation past the TTL clears the cache for everything', async () => {
        const seen = recordRequests();
        await cached();
        await jest.advanceTimersByTimeAsync(11 * MIN);

        await client.query({ query: OTHER });
        await flush();
        await cached();

        expect(await countOps(seen, 'LinkProbe')).toBe(2);
    });
});

describe('apollo-cache-evict task', () => {
    const definition = () =>
        (AppScheduler as unknown as { tasks: Map<string, TaskDefinition> }).tasks.get('apollo-cache-evict');

    it('registers itself with the scheduler on import, with the cadence and limits it was built for', () => {
        expect(definition()).toMatchObject({
            name: 'apollo-cache-evict',
            displayName: 'Apollo Cache Eviction',
            frequency: 10 * MIN,
            timeout: 5_000,
            maxAttempts: 1,
            exclusive: false,
        });
        expect(definition()?.triggers).toContain('app-foreground');
        // The count, not toContain: an added condition would silently gate the eviction.
        expect(definition()?.conditions ?? []).toHaveLength(0);
    });

    it('running it evicts an expired cache', async () => {
        const seen = recordRequests();
        await cached();
        await jest.advanceTimersByTimeAsync(11 * MIN);

        await expect(advanceUntilDone(AppScheduler.trigger('apollo-cache-evict'))).resolves.toBe('ran');
        await flush();
        await cached();

        expect(await countOps(seen, 'LinkProbe')).toBe(2);
        expect(useSchedulerStore.getState().getLastRun('apollo-cache-evict')).toEqual(expect.any(Number));
    });

    it('running it inside the TTL leaves the cache alone', async () => {
        const seen = recordRequests();
        await cached();
        await jest.advanceTimersByTimeAsync(2 * MIN);

        await advanceUntilDone(AppScheduler.trigger('apollo-cache-evict'));
        await cached();

        expect(await countOps(seen, 'LinkProbe')).toBe(1);
    });
});
