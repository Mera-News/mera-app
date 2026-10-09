// The per-scope headline depth overrides in the persona request. They sit behind the
// HEADLINE_DEPTH_UI_ENABLED ship gate, so the one non-edge mock here is that compile-time
// constant (R27): a configuration switch, not behaviour. The gate OFF case is in
// fetch-topic-ids.test.ts. Replaces the depth cases of
// lib/scheduler/feed-sync/__tests__/feed-sync-steps.test.ts.
jest.mock('@/lib/config/feature-gates', () => ({
  ...jest.requireActual('@/lib/config/feature-gates'),
  HEADLINE_DEPTH_UI_ENABLED: true,
}));
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

import * as headlineDepth from '@/lib/database/services/headline-depth-service';
import { setHeadlineDepth } from '@/lib/database/services/headline-depth-service';
import { stepFetchTopicIds } from '@/lib/scheduler/feed-sync/feed-sync-steps';
import logger from '@/lib/logger';
import {
  cleanupFeedSync,
  makeCtx,
  recordOps,
  resetFeedSyncMemory,
  seedInterest,
  seedLocation,
  spyOnExport,
} from './support';

beforeEach(resetFeedSyncMemory);
afterEach(cleanupFeedSync);

async function sentScopes() {
  const sent = recordOps();
  await stepFetchTopicIds('', makeCtx().ctx);
  const [{ variables }] = await sent.named('GetArticleIdsForPersona');
  return variables.query.topHeadlines.scopes as { scope: string; countryCode: string | null; limit?: number }[];
}

describe('headline depth overrides', () => {
  it('threads each overridden scope depth into its scope and leaves the other scopes without a limit', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    await seedLocation('NL', 0.9);
    await seedLocation('DE', 0.5, 'work');
    await setHeadlineDepth('NL', 12);
    await setHeadlineDepth('GLOBAL', 3);

    const scopes = await sentScopes();

    expect(scopes).toEqual([
      { scope: 'COUNTRY', countryCode: 'NL', limit: 12 },
      { scope: 'COUNTRY', countryCode: 'DE' },
      { scope: 'GLOBAL', countryCode: null, limit: 3 },
    ]);
  });

  it('sends no limit at all when nothing is overridden', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    await seedLocation('NL', 0.9);

    for (const scope of await sentScopes()) expect(scope).not.toHaveProperty('limit');
  });

  it('syncs with default depths when the depth read throws, and says so', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    await seedLocation('NL', 0.9);
    await setHeadlineDepth('NL', 12);
    spyOnExport(headlineDepth, 'getHeadlineDepths').mockRejectedValueOnce(new Error('settings unreadable'));

    const scopes = await sentScopes();

    for (const scope of scopes) expect(scope).not.toHaveProperty('limit');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('headline depths unreadable'), expect.any(Error));
  });
});
