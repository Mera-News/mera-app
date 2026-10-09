// Arms the six deleted legacy suites (deletion batch G35) reached and the retention seam tests did
// not, found by diffing per-line branch coverage of fact-check-record-service and
// tracked-story-service with and without those suites (data-U20):
//  - fact-check-record-service: the empty `payload_json` arm of deleteExpiredFactChecks;
//  - tracked-story-service: a snapshot with no pubDateMs in mergeMemberSnapshots' sort, and
//    sortTrackedStories ordering when the second story of a pair has unseen updates.
//
// Not covered here, R30 candidates (no real row can reach them, so only a mocked record or a
// predicate-ignoring query could):
//  - tracked-story-service.ts `matchesTrackedQuery`: `if (row.status !== 'active') return false`.
//    Its three callers (isTracked, observeTrackedId, findActiveTrackedId) all query
//    `Q.where('status', 'active')` first; the line's own comment says it guards "test mock ignores
//    predicate".
//  - tracked-story-service.ts removeMemberSnapshot: `record.memberSnapshots ?? []`. The model's
//    @json getter runs sanitizeSnapshots, which returns an array for any stored value.
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
import { deleteExpiredFactChecks, listFactChecks } from '@/lib/database/services/fact-check-record-service';
import {
  applyUpdates,
  getTrackedStoryById,
  observeActive,
  trackStory,
  type TrackedStoryMemberSnapshot,
} from '@/lib/database/services/tracked-story-service';
import { useFakeClock } from '@/test/helpers';
import { collect, rawTracked, restoreFaults, restoreRows, waitFor } from './support';

afterEach(restoreFaults);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

beforeEach(() => useFakeClock(NOW));

describe('deleteExpiredFactChecks with an empty payload_json', () => {
  /** A bare row whose payload_json is the empty string: no current writer makes one, an older build did. */
  async function seedEmptyPayload(articleId: string, ageMs: number): Promise<void> {
    await database.write(async () => {
      await database.get('fact_checks').create((rec: any) => {
        rec.articleId = articleId;
        rec.factCheckId = 'older-build';
        rec.articleTitle = 'A headline';
        rec.status = 'pending';
        rec.verdict = null;
        rec.payloadJson = '';
        rec.requestedAt = new Date(NOW - ageMs);
        rec.resolvedAt = new Date(NOW - ageMs);
        rec.claim = null;
        rec.claimKey = articleId;
      });
    });
  }

  it('decays like an empty checkedBy: gone past 7 days, kept at 6, and still capped at 90', async () => {
    await seedEmptyPayload('old', 8 * DAY);
    await seedEmptyPayload('young', 6 * DAY);
    await seedEmptyPayload('ancient', 100 * DAY);

    expect(await deleteExpiredFactChecks(NOW - 7 * DAY, NOW - 90 * DAY)).toBe(2);

    expect((await listFactChecks()).map((r) => r.articleId)).toEqual(['young']);
  });
});

describe('tracked stories whose fields are missing', () => {
  const noDate = (articleId: string) => ({ articleId, title: `Title ${articleId}` }) as TrackedStoryMemberSnapshot;
  const dated = (articleId: string, pubDateMs: number): TrackedStoryMemberSnapshot => ({
    articleId,
    title: `Title ${articleId}`,
    pubDateMs,
  });

  it('merges snapshots that carry no pubDateMs after every dated one, keeping the dated ones newest first', async () => {
    const { id } = await trackStory({ articleId: 'seed', title: 'T', originSurface: 'x', initialSnapshot: dated('seed', 1_000) });

    await applyUpdates(id, {
      newMemberIds: ['u1', 'd2', 'u2', 'd3'],
      newSnapshots: [noDate('u1'), dated('d2', 9_000), noDate('u2'), dated('d3', 5_000)],
    });

    const ids = (await getTrackedStoryById(id))!.memberSnapshots.map((s) => s.articleId);
    expect(ids.slice(0, 3)).toEqual(['d2', 'd3', 'seed']);
    expect(ids.slice(3).sort()).toEqual(['u1', 'u2']);
  });

  it('lists a story with unseen updates before quiet ones whichever order the rows were stored in', async () => {
    // a-unseen is older than the quiet stories, so only the unseen rule can put it first
    await restoreRows({
      tracked_stories: [
        rawTracked('a-unseen', { unseen_count: 2, last_update_at: NOW - 3_000 }),
        rawTracked('b-quiet', { last_update_at: NOW - 1_000 }),
        rawTracked('c-quiet', { last_update_at: NOW - 2_000 }),
        rawTracked('d-unseen', { unseen_count: 1, last_update_at: NOW - 4_000 }),
      ],
    });

    const lists = collect(observeActive());
    await waitFor(() => lists.length > 0);

    expect(lists[lists.length - 1].map((r) => r.id)).toEqual(['a-unseen', 'd-unseen', 'b-quiet', 'c-quiet']);
  });
});
