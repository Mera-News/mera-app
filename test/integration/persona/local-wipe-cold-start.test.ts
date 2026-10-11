// The launch-time resume of an interrupted logout, as a real cold start sees it. This file never calls
// __resetLocalWipeForTests(): the first purgeOrphanedLocalData() call must find the module's own initial
// state, which is what a fresh app process gets. (logout-wipe.test.ts resets the once-per-process latch
// before every case, so it cannot tell a latch that starts open from one that starts closed.)
import * as factService from '@/lib/database/services/fact-service';
import { purgeOrphanedLocalData } from '@/lib/security/local-wipe';

beforeAll(() => {
    // The wipe requires these lazily; their cold load takes seconds and must not land inside the test.
    /* eslint-disable @typescript-eslint/no-require-imports */
    for (const m of [
        '@/lib/auth-client',
        '@/lib/backup/providers/google-drive',
        '@/lib/database',
        '@/lib/database/services/setting-service',
        '@/lib/intercom',
        '@/lib/observability/sentry-scope',
        '@/lib/revenuecat',
        '@/lib/stores',
        '@/lib/stores/pin-store',
    ]) require(m);
    /* eslint-enable @typescript-eslint/no-require-imports */
}, 60_000);

it('the first launch after an interrupted logout finishes the wipe', async () => {
    // No credentials, user data still on disk: the state a logout leaves when it dies before its erase.
    await factService.addFact('I follow Formula 1 racing');

    await expect(purgeOrphanedLocalData()).resolves.toBe(true);

    expect(await factService.hasAnyFacts()).toBe(false);
});
