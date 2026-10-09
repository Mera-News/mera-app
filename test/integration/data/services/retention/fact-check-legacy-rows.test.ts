// States of the fact_checks table that no current writer can produce but real devices still hold, so
// each is seeded as a bare row (fact_checks is not in the backup allowlist, so a restore cannot make
// them either):
//  - two rows with the same (article_id, claim_key): an older build's pre-index race left them;
//  - a row whose payload_json is not JSON: disk corruption or an older writer.
// Covers fact-check-record-service's duplicate collapse in upsertFactCheck, the corrupt-payload
// degrade in toStored and the corrupt-payload branch of deleteExpiredFactChecks.
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

import database from '@/lib/database';
import {
  deleteExpiredFactChecks,
  getFactCheckForClaim,
  listFactChecks,
  listFactChecksForArticle,
  upsertFactCheck,
} from '@/lib/database/services/fact-check-record-service';
import { useFakeClock } from '@/test/helpers';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

interface RawCheck {
  articleId: string;
  claimKey: string | null;
  verdict?: string;
  payloadJson?: string;
  requestedAt?: number;
}

/** A bare row, written the way no current service writes it. */
async function seedRaw(rows: RawCheck[]): Promise<void> {
  await database.write(async () => {
    for (const r of rows) {
      await database.get('fact_checks').create((rec: any) => {
        rec.articleId = r.articleId;
        rec.factCheckId = 'older-build';
        rec.articleTitle = 'A headline';
        rec.status = 'complete';
        rec.verdict = r.verdict ?? 'old-verdict';
        rec.payloadJson = r.payloadJson ?? '{"checkedBy":[]}';
        rec.requestedAt = new Date(r.requestedAt ?? NOW);
        rec.resolvedAt = new Date(r.requestedAt ?? NOW);
        rec.claim = r.claimKey ? `claim ${r.claimKey}` : null;
        rec.claimKey = r.claimKey;
      });
    }
  });
}

beforeEach(() => useFakeClock(NOW));

describe('duplicate rows for one (article, claim)', () => {
  it('an upsert collapses them to exactly one row with the new values, and touches no other claim or article', async () => {
    await seedRaw([
      { articleId: 'a1', claimKey: 'k1', verdict: 'dupe-a' },
      { articleId: 'a1', claimKey: 'k1', verdict: 'dupe-b' },
      { articleId: 'a1', claimKey: 'k2', verdict: 'other-claim' },
      { articleId: 'a2', claimKey: 'k1', verdict: 'other-article' },
    ]);
    expect(await listFactChecksForArticle('a1')).toHaveLength(3);

    await upsertFactCheck({
      articleId: 'a1',
      factCheckId: 'fc-new',
      status: 'complete',
      verdict: 'supported',
      payload: { n: 2 },
      claimKey: 'k1',
      claim: 'claim k1',
    });

    const a1 = await listFactChecksForArticle('a1');
    expect(a1.filter((r) => r.claimKey === 'k1')).toHaveLength(1);
    expect(a1.find((r) => r.claimKey === 'k1')).toMatchObject({ verdict: 'supported', factCheckId: 'fc-new', payload: { n: 2 } });
    expect(a1.find((r) => r.claimKey === 'k2')!.verdict).toBe('other-claim');
    expect((await listFactChecksForArticle('a2')).map((r) => r.verdict)).toEqual(['other-article']);
  });
});

describe('a row whose payload_json is not JSON', () => {
  it('reads back with a null payload and its status, verdict and title intact', async () => {
    await seedRaw([{ articleId: 'a1', claimKey: 'k1', verdict: 'supported', payloadJson: '{not json' }]);

    const stored = await getFactCheckForClaim('a1', 'k1');

    expect(stored).toMatchObject({ articleId: 'a1', status: 'complete', verdict: 'supported', articleTitle: 'A headline', payload: null });
    expect(await listFactChecks()).toHaveLength(1);
  });

  it('is kept by the sweep while under the 90-day hard cap, even past 7 days, and deleted past it', async () => {
    await seedRaw([
      { articleId: 'kept', claimKey: 'k', payloadJson: '{not json', requestedAt: NOW - 60 * DAY },
      { articleId: 'dropped', claimKey: 'k', payloadJson: '{not json', requestedAt: NOW - 100 * DAY },
    ]);

    expect(await deleteExpiredFactChecks(NOW - 7 * DAY, NOW - 90 * DAY)).toBe(1);

    // an unreadable payload cannot be confirmed unattributed, so it waits for the hard cap
    expect((await listFactChecks()).map((r) => r.articleId)).toEqual(['kept']);
  });
});
