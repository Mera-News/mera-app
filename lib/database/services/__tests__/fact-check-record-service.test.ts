// v52 changed the upsert key from `article_id` to `(article_id, claim_key)`,
// and that is exactly the kind of change that looks additive and silently
// destroys data.
//
// The failure mode this file exists to catch: the duplicate-collapse inside
// `upsertFactCheck` destroys every row the lookup returned except the first. If
// the lookup is scoped to `article_id` alone, checking a SECOND claim on an
// article deletes the first claim's answer — permanently, because after the
// pivot there is no server copy to re-fetch. So the tests below run the real
// service against a predicate-AWARE fake collection (the shared mock ignores
// `Q.where`, which would make every one of them pass regardless) and assert
// that siblings survive.
//
// The second rule: a v51 row has `claim_key = NULL`, meaning "the legacy
// whole-article check". A keyed lookup must never match it, or the first
// per-claim check a user runs would overwrite the answer they already had.

jest.mock('@/lib/database/index', () => {
    const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
    return makeDatabaseMock();
});

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: jest.fn(), warn: jest.fn(), error: jest.fn(),
        debug: jest.fn(), info: jest.fn(),
    },
}));

import database from '@/lib/database/index';
import { makeRecord, type MockDatabase } from '@/lib/__test-helpers__/mockDatabase';
import {
    deleteExpiredFactChecks,
    getFactCheckForArticle,
    getFactCheckForClaim,
    listFactChecksByStatus,
    listFactChecksForArticle,
    upsertFactCheck,
} from '../fact-check-record-service';

const db = database as unknown as MockDatabase;
const collection = () => db._collections['fact_checks'];

/** Applies the `Q` clauses the service actually passed. Without this the shared
 *  mock returns every row and a composite-key bug is invisible. */
function applyClauses(rows: any[], clauses: any[]): any[] {
    let out = [...rows];
    for (const clause of clauses) {
        if (clause?.type === 'where') {
            const col = clause.left;
            const operator = clause.comparison?.operator ?? 'eq';
            const want = clause.comparison?.right?.value ?? null;
            const prop = col.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
            out = out.filter((r) => {
                let actual = r[prop] ?? null;
                if (actual instanceof Date) actual = actual.getTime();
                if (operator === 'lt') return actual != null && actual < want;
                return actual === want;
            });
        } else if (clause?.type === 'sortBy') {
            const prop = clause.sortColumn.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
            const dir = clause.sortOrder === 'desc' ? -1 : 1;
            out.sort((a, b) => {
                const av = a[prop] instanceof Date ? a[prop].getTime() : (a[prop] ?? 0);
                const bv = b[prop] instanceof Date ? b[prop].getTime() : (b[prop] ?? 0);
                return av === bv ? 0 : (av < bv ? -1 : 1) * dir;
            });
        } else if (clause?.type === 'take') {
            out = out.slice(0, clause.count);
        }
    }
    return out;
}

function row(overrides: Record<string, unknown>) {
    return makeRecord({
        id: `r-${Math.random().toString(36).slice(2)}`,
        articleId: 'a1',
        factCheckId: 'fc',
        articleTitle: 'T',
        status: 'complete',
        verdict: null,
        payloadJson: '{}',
        requestedAt: new Date(1000),
        resolvedAt: null,
        claim: null,
        claimKey: null,
        ...overrides,
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    db._setRows('fact_checks', []);
    const col = collection();
    col.query = jest.fn((...clauses: any[]) => ({
        fetch: jest.fn(async () => applyClauses(col._rows, clauses)),
        fetchCount: jest.fn(async () => applyClauses(col._rows, clauses).length),
    })) as any;
    col.create = jest.fn(async (fn?: (r: any) => void) => {
        const rec = row({ claim: null, claimKey: null });
        fn?.(rec);
        col._rows.push(rec);
        return rec;
    }) as any;
});

describe('the composite upsert key', () => {
    it('two claims on one article produce TWO rows — neither destroys the other', async () => {
        await upsertFactCheck({
            articleId: 'a1', factCheckId: 'fc1', claimKey: 'k1', claim: 'claim one',
            status: 'complete', verdict: 'supported', payload: { n: 1 },
        });
        await upsertFactCheck({
            articleId: 'a1', factCheckId: 'fc2', claimKey: 'k2', claim: 'claim two',
            status: 'complete', verdict: 'disputed', payload: { n: 2 },
        });

        const rows = await listFactChecksForArticle('a1');
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.claimKey).sort()).toEqual(['k1', 'k2']);
        // The first claim's ANSWER is still there — this is the assertion that
        // goes red if the collapse loop is scoped to `article_id`.
        expect(rows.find((r) => r.claimKey === 'k1')!.verdict).toBe('supported');
    });

    it('re-checking the SAME claim updates in place instead of duplicating', async () => {
        await upsertFactCheck({
            articleId: 'a1', factCheckId: 'fc1', claimKey: 'k1', claim: 'c',
            status: 'processing', payload: { n: 1 },
        });
        await upsertFactCheck({
            articleId: 'a1', factCheckId: 'fc1', claimKey: 'k1', claim: 'c',
            status: 'complete', verdict: 'mixed', payload: { n: 2 },
        });

        const rows = await listFactChecksForArticle('a1');
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('complete');
        expect(rows[0].payload).toEqual({ n: 2 });
    });

    it('collapses accidental duplicates of the SAME claim only', async () => {
        collection()._setRows([
            row({ id: 'dupe-a', claimKey: 'k1', claim: 'c', verdict: 'x' }),
            row({ id: 'dupe-b', claimKey: 'k1', claim: 'c', verdict: 'y' }),
            row({ id: 'other', claimKey: 'k2', claim: 'other', verdict: 'keep' }),
        ]);
        await upsertFactCheck({
            articleId: 'a1', factCheckId: 'fc', claimKey: 'k1', claim: 'c',
            status: 'complete', verdict: 'supported', payload: {},
        });

        const rows = collection()._rows;
        expect(rows.find((r: any) => r.id === 'dupe-b')!.destroyPermanently).toHaveBeenCalled();
        expect(rows.find((r: any) => r.id === 'other')!.destroyPermanently).not.toHaveBeenCalled();
    });

    it('a different ARTICLE is never touched', async () => {
        collection()._setRows([row({ id: 'other-article', articleId: 'a2', claimKey: 'k1' })]);
        await upsertFactCheck({
            articleId: 'a1', factCheckId: 'fc', claimKey: 'k1', claim: 'c',
            status: 'complete', payload: {},
        });
        expect(collection()._rows).toHaveLength(2);
    });
});

describe('a v51 (legacy) row keeps its own slot', () => {
    it('a keyed upsert does NOT overwrite the legacy whole-article row', async () => {
        collection()._setRows([
            row({ id: 'legacy', claimKey: null, claim: null, verdict: 'legacy-verdict' }),
        ]);

        await upsertFactCheck({
            articleId: 'a1', factCheckId: 'fc1', claimKey: 'k1', claim: 'a new claim',
            status: 'complete', verdict: 'supported', payload: {},
        });

        const rows = await listFactChecksForArticle('a1');
        expect(rows).toHaveLength(2);
        const legacy = rows.find((r) => r.claimKey === null)!;
        expect(legacy.verdict).toBe('legacy-verdict');
        expect(legacy.claim).toBeNull();
    });

    it('a keyed lookup never resolves to the legacy row', async () => {
        collection()._setRows([row({ id: 'legacy', claimKey: null, verdict: 'legacy-verdict' })]);
        expect(await getFactCheckForClaim('a1', 'k1')).toBeNull();
        // …and asking for the legacy slot specifically still finds it.
        expect((await getFactCheckForClaim('a1'))?.verdict).toBe('legacy-verdict');
    });

    it('the legacy row is still reachable by article for the orphan card', async () => {
        collection()._setRows([row({ id: 'legacy', claimKey: null, verdict: 'legacy-verdict' })]);
        expect((await getFactCheckForArticle('a1'))?.verdict).toBe('legacy-verdict');
    });
});

describe('listFactChecksByStatus — the recovery task s input', () => {
    it('returns only the requested status', async () => {
        collection()._setRows([
            row({ id: 'p', status: 'processing', claimKey: 'k1' }),
            row({ id: 'c', status: 'complete', claimKey: 'k2' }),
        ]);
        const rows = await listFactChecksByStatus('processing');
        expect(rows.map((r) => r.id)).toEqual(['p']);
    });

    it('is bounded', async () => {
        collection()._setRows(
            Array.from({ length: 30 }, (_, i) => row({ id: `p${i}`, status: 'processing', claimKey: `k${i}` })),
        );
        expect(await listFactChecksByStatus('processing')).toHaveLength(20);
        expect(await listFactChecksByStatus('processing', 5)).toHaveLength(5);
    });
});

describe('reads never throw', () => {
    it('a corrupt payload degrades to null instead of dying', async () => {
        collection()._setRows([row({ claimKey: 'k1', payloadJson: '{not json' })]);
        const stored = await getFactCheckForClaim('a1', 'k1');
        expect(stored).not.toBeNull();
        expect(stored!.payload).toBeNull();
    });

    it('a throwing query returns an empty list', async () => {
        collection().query = jest.fn(() => { throw new Error('db gone'); }) as any;
        expect(await listFactChecksForArticle('a1')).toEqual([]);
        expect(await getFactCheckForClaim('a1', 'k1')).toBeNull();
    });
});

describe('deleteExpiredFactChecks — the retention sweep', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const NOW = 1_000_000 * DAY_MS; // an arbitrary "now" far from epoch 0
    const SEVEN_DAYS_AGO = NOW - 7 * DAY_MS;
    const NINETY_DAYS_AGO = NOW - 90 * DAY_MS;

    function oldRow(overrides: Record<string, unknown>) {
        return row({
            requestedAt: new Date(NOW - 8 * DAY_MS), // past the 7-day cutoff
            ...overrides,
        });
    }

    // Attribution buys a row past the 7-day sweep — that is the whole reason
    // the sweep reads the payload instead of just the age.
    it('KEEPS a populated checkedBy row past 7 days, while it is inside 90', async () => {
        collection()._setRows([
            oldRow({
                id: 'attributed',
                requestedAt: new Date(NOW - 60 * DAY_MS),
                payloadJson: JSON.stringify({
                    checkedBy: [{ organisation: 'Alt News', verdict: 'False' }],
                }),
            }),
        ]);

        const deleted = await deleteExpiredFactChecks(SEVEN_DAYS_AGO, NINETY_DAYS_AGO);

        expect(deleted).toBe(0);
        const stored = collection()._rows.find((r: any) => r.id === 'attributed');
        expect(stored.prepareDestroyPermanently).not.toHaveBeenCalled();
    });

    // ...but it does NOT buy it forever. This is the behaviour change: an
    // attributed row used to be immortal, which quietly assumed a published
    // rating never changes. Fact-checkers revise and retract, so a cached
    // verdict can drift out of agreement with the organisation still named on
    // it, and the reader cannot tell. Deleting is self-healing — the row is
    // re-fetchable, and the server holds the same 90-day rule.
    it('DELETES a populated checkedBy row once it is past 90 days', async () => {
        collection()._setRows([
            oldRow({
                id: 'stale-attributed',
                requestedAt: new Date(NOW - 400 * DAY_MS), // over a year old
                payloadJson: JSON.stringify({
                    checkedBy: [{ organisation: 'Alt News', verdict: 'False' }],
                }),
            }),
        ]);

        const deleted = await deleteExpiredFactChecks(SEVEN_DAYS_AGO, NINETY_DAYS_AGO);

        expect(deleted).toBe(1);
        const stored = collection()._rows.find((r: any) => r.id === 'stale-attributed');
        expect(stored.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
    });

    it('DELETES an unreadable payload past 90 days — the hard cap does not read it', async () => {
        // The "keep what you cannot parse" benefit of the doubt is no longer
        // open-ended. It defers the decision; it does not cancel it. Otherwise
        // one corrupt blob is immortal, which is the immortality this cap
        // exists to remove.
        collection()._setRows([
            oldRow({
                id: 'stale-malformed',
                requestedAt: new Date(NOW - 120 * DAY_MS),
                payloadJson: '{not valid json',
            }),
        ]);

        expect(await deleteExpiredFactChecks(SEVEN_DAYS_AGO, NINETY_DAYS_AGO)).toBe(1);
    });

    it('applies the hard cap to each row independently, not to the batch', async () => {
        collection()._setRows([
            oldRow({
                id: 'keep-recent-attributed',
                requestedAt: new Date(NOW - 30 * DAY_MS),
                payloadJson: JSON.stringify({ checkedBy: [{ organisation: 'BOOM' }] }),
            }),
            oldRow({
                id: 'drop-old-attributed',
                requestedAt: new Date(NOW - 200 * DAY_MS),
                payloadJson: JSON.stringify({ checkedBy: [{ organisation: 'BOOM' }] }),
            }),
        ]);

        expect(await deleteExpiredFactChecks(SEVEN_DAYS_AGO, NINETY_DAYS_AGO)).toBe(1);
        const rows = collection()._rows;
        expect(
            rows.find((r: any) => r.id === 'keep-recent-attributed').prepareDestroyPermanently,
        ).not.toHaveBeenCalled();
        expect(
            rows.find((r: any) => r.id === 'drop-old-attributed').prepareDestroyPermanently,
        ).toHaveBeenCalledTimes(1);
    });

    it('deletes an unattributed (empty checkedBy) row once it is past 7 days old', async () => {
        collection()._setRows([
            oldRow({ id: 'unattributed', payloadJson: JSON.stringify({ checkedBy: [] }) }),
        ]);

        const deleted = await deleteExpiredFactChecks(SEVEN_DAYS_AGO, NINETY_DAYS_AGO);

        expect(deleted).toBe(1);
        const stored = collection()._rows.find((r: any) => r.id === 'unattributed');
        expect(stored.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
    });

    it('does NOT delete an unattributed row that is only 6 days old', async () => {
        collection()._setRows([
            row({
                id: 'young-unattributed',
                requestedAt: new Date(NOW - 6 * DAY_MS),
                payloadJson: JSON.stringify({ checkedBy: [] }),
            }),
        ]);

        const deleted = await deleteExpiredFactChecks(SEVEN_DAYS_AGO, NINETY_DAYS_AGO);

        expect(deleted).toBe(0);
        const stored = collection()._rows.find((r: any) => r.id === 'young-unattributed');
        expect(stored.prepareDestroyPermanently).not.toHaveBeenCalled();
    });

    it('does NOT delete a row with unparseable payload_json — cannot confirm unattributed', async () => {
        collection()._setRows([
            oldRow({ id: 'malformed', payloadJson: '{not valid json' }),
        ]);

        const deleted = await deleteExpiredFactChecks(SEVEN_DAYS_AGO, NINETY_DAYS_AGO);

        expect(deleted).toBe(0);
        const stored = collection()._rows.find((r: any) => r.id === 'malformed');
        expect(stored.prepareDestroyPermanently).not.toHaveBeenCalled();
    });

    // A parsed-but-missing checkedBy is a REAL shape, not hypothetical:
    // `requestFactCheck` stores `payload: null` for the `pending` stub row it
    // writes when the server's first response doesn't echo a full row back
    // (fact-check-graphql-client.ts). That stub carries no attribution by
    // construction and must decay like an explicit `checkedBy: []`, or a
    // stuck/never-resolved request would sit in the table forever.
    it('DELETES a readable row whose payload has no checkedBy array at all', async () => {
        collection()._setRows([
            oldRow({ id: 'no-field', payloadJson: JSON.stringify({ status: 'blocked' }) }),
            oldRow({ id: 'null-payload', payloadJson: JSON.stringify(null) }), // the pending stub shape
            oldRow({ id: 'empty-string-payload', payloadJson: '' }),
        ]);

        const deleted = await deleteExpiredFactChecks(SEVEN_DAYS_AGO, NINETY_DAYS_AGO);

        expect(deleted).toBe(3);
        for (const id of ['no-field', 'null-payload', 'empty-string-payload']) {
            expect(collection()._rows.find((r: any) => r.id === id).prepareDestroyPermanently)
                .toHaveBeenCalledTimes(1);
        }
    });

    it('mixes kept and deleted rows correctly in one sweep', async () => {
        collection()._setRows([
            oldRow({ id: 'keep-attributed', payloadJson: JSON.stringify({ checkedBy: [{ organisation: 'BOOM' }] }) }),
            oldRow({ id: 'delete-empty', payloadJson: JSON.stringify({ checkedBy: [] }) }),
            row({ id: 'keep-young', requestedAt: new Date(NOW - 1 * DAY_MS), payloadJson: JSON.stringify({ checkedBy: [] }) }),
        ]);

        const deleted = await deleteExpiredFactChecks(SEVEN_DAYS_AGO, NINETY_DAYS_AGO);

        expect(deleted).toBe(1);
        const rows = collection()._rows;
        expect(rows.find((r: any) => r.id === 'keep-attributed').prepareDestroyPermanently).not.toHaveBeenCalled();
        expect(rows.find((r: any) => r.id === 'delete-empty').prepareDestroyPermanently).toHaveBeenCalledTimes(1);
        expect(rows.find((r: any) => r.id === 'keep-young').prepareDestroyPermanently).not.toHaveBeenCalled();
    });

    it('a throwing query returns 0 rather than throwing', async () => {
        collection().query = jest.fn(() => { throw new Error('db gone'); }) as any;
        expect(await deleteExpiredFactChecks(SEVEN_DAYS_AGO, NINETY_DAYS_AGO)).toBe(0);
    });
});
