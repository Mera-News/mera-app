// route1 P8a: a scoring outage (NEAR attestation 503 or a hang) while the hydrate chunk loop enqueues
// must not fail the refresh. Rows stay unscored for the next pass, the scoring lane is marked out, and
// no "Analyzing relevance" phase is left standing for a run that never started.
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import { _resetForTests, getPipelineStatus } from '@/lib/services/scoring-pipeline';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { advanceUntilDone, delay, http, HttpResponse, server } from '@/test/helpers';
import { cleanupFeedSync, ids, resetFeedSyncMemory, resetScoringWorld, rowsById } from '../steps/support';
import { feedSyncMachine, serveNew, settleMachine, startMachine, watchScoring } from './support';

jest.setTimeout(60_000);

const store = () => useForYouStore.getState();

describe('a scoring outage during the hydrate', () => {
  beforeEach(async () => {
    resetFeedSyncMemory();
    _resetForTests();
    await resetScoringWorld();
    watchScoring();
    store().setLaneOutage('scoring', null);
  });
  afterEach(async () => {
    await settleMachine();
    cleanupFeedSync();
    store().setLaneOutage('scoring', null);
  });

  const cases: [string, () => ReturnType<typeof http.get>][] = [
    ['an attestation 503', () => http.get('*/api/attestation/report', () => new HttpResponse('down', { status: 503 }))],
    ['an attestation hang', () => http.get('*/api/attestation/report', async () => { await delay('infinite'); return new HttpResponse(null); })],
  ];

  it.each(cases)('%s keeps the refresh green with the rows saved and unscored', async (_name, handler) => {
    const articleIds = ids(5, 'o');
    await serveNew(articleIds);
    server.use(handler());

    await expect(advanceUntilDone(startMachine())).resolves.toBeUndefined();

    expect(feedSyncMachine.state).toBe('done');
    expect(store().syncStatusMessage?.state).not.toBe('failed');
    expect(store().syncStatusMessage?.errorCode).toBeUndefined();
    const rows = await rowsById();
    expect(articleIds.map((id) => rows.get(id)?.status)).toEqual(articleIds.map(() => 'unscored'));
    expect(store().laneOutage.scoring?.since).toEqual(expect.any(Number));
    expect(await getPipelineStatus()).toBe('idle');
    expect(store().asyncJobPhase).toBe('idle');
  });

  it('clears the outage once a run can be created again', async () => {
    await serveNew(ids(5, 'r'));
    server.use(cases[0][1]());
    await advanceUntilDone(startMachine());
    expect(store().laneOutage.scoring).toBeDefined();

    server.resetHandlers();
    jest.setSystemTime(Date.now() + 5 * 60_000);
    await serveNew(ids(5, 'q'));
    await advanceUntilDone(startMachine());

    expect(store().laneOutage.scoring).toBeUndefined();
  });
});
