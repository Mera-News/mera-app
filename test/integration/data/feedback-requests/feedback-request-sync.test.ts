// Seam test for one pass of "what is the server asking right now": the real fetch through MSW, the
// real state row and the real drawer rows (notification table) on the in-memory DB.
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import * as settingService from '@/lib/database/services/setting-service';
import {
    FEEDBACK_REQUESTS_STATE_KEY,
    __resetFeedbackRequestStateForTests,
    markFeedbackRequestShown,
    pickAutoShowCandidate,
    readFeedbackRequestsState,
    subscribeFeedbackRequestsState,
} from '@/lib/feedback-requests/feedback-request-state';
import {
    feedbackRequestNotificationSource,
    ingestFeedbackRequests,
    syncFeedbackRequests,
} from '@/lib/feedback-requests/feedback-request-sync';
import { server } from '@/test/helpers';
import {
    A,
    B,
    HOUR,
    NOW,
    drawerRows,
    failOp,
    opsNamed,
    recordOps,
    req,
    restoreAfterTest,
    resetNetworkAndBanner,
    serverList,
    setDeviceLink,
    settleRecorder,
    spyLogger,
    view,
} from './support';

beforeEach(() => {
    __resetFeedbackRequestStateForTests();
    resetNetworkAndBanner();
});

const stateRow = async () => JSON.parse((await getSetting(FEEDBACK_REQUESTS_STATE_KEY)) ?? '{}');
const iso = (ms: number) => new Date(ms).toISOString();

describe('syncFeedbackRequests', () => {
    it('asks the server in the server locale for the app language', async () => {
        const sent = recordOps();
        await syncFeedbackRequests('zh-Hans', NOW);
        await settleRecorder();
        expect(opsNamed(sent, 'ActiveFeedbackRequests').map((s) => s.variables)).toEqual([{ locale: 'zh-CN' }]);
    });

    it('a failed fetch is ok false and changes nothing', async () => {
        spyLogger();
        setDeviceLink(false);
        server.use(failOp('ActiveFeedbackRequests'));
        await expect(syncFeedbackRequests('en', NOW)).resolves.toEqual({ ok: false, fetched: 0, newRows: 0, answered: 0 });
        expect(await getSetting(FEEDBACK_REQUESTS_STATE_KEY)).toBeNull();
        expect(await drawerRows()).toEqual([]);
    });

    it('a failed fetch leaves existing local entries open, not clamped', async () => {
        spyLogger();
        await ingestFeedbackRequests([req(A)], NOW);
        setDeviceLink(false);
        server.use(failOp('ActiveFeedbackRequests'));
        await syncFeedbackRequests('en', NOW + 10);
        expect((await stateRow())[A].endsAt).toBe(NOW + HOUR);
    });

    it('an empty list is a normal, quiet result', async () => {
        await expect(syncFeedbackRequests('en', NOW)).resolves.toEqual({ ok: true, fetched: 0, newRows: 0, answered: 0 });
        expect(await getSetting(FEEDBACK_REQUESTS_STATE_KEY)).toBeNull();
        expect(await drawerRows()).toEqual([]);
    });

    it('a new request: a state entry and ONE drawer row with the raw question', async () => {
        server.use(serverList(view(A, { question: 'Q?', endsAt: iso(NOW + 10) })));
        await expect(syncFeedbackRequests('en', NOW)).resolves.toEqual({ ok: true, fetched: 1, newRows: 1, answered: 0 });
        expect((await stateRow())[A]).toEqual({ question: 'Q?', endsAt: NOW + 10 });
        expect(await drawerRows()).toEqual([
            {
                source: `feedback_request:${A}`,
                title: 'feedbackRequest.title',
                body: 'Q?',
                icon: null,
                status: 'unread',
                context: { feedbackRequestId: A, endsAt: NOW + 10 },
            },
        ]);

        // A second sync of the same request: no second row.
        await expect(syncFeedbackRequests('en', NOW)).resolves.toEqual({ ok: true, fetched: 1, newRows: 0, answered: 0 });
        expect(await drawerRows()).toHaveLength(1);
    });

    it('stores a question with colons and dots raw, for the drawer to render directly', async () => {
        server.use(serverList(view(A, { question: 'Which do you prefer: A. fast or B. cheap?' })));
        await syncFeedbackRequests('en', NOW);
        expect((await drawerRows())[0].body).toBe('Which do you prefer: A. fast or B. cheap?');
    });

    it('refreshes the question (re-localized) and endsAt, keeping the stamps', async () => {
        server.use(serverList(view(A, { question: 'Q?', endsAt: iso(NOW + 10) })));
        await syncFeedbackRequests('en', NOW);
        await markFeedbackRequestShown(A, NOW + 1);
        server.use(serverList(view(A, { question: 'F?', endsAt: iso(NOW + 20) })));
        await syncFeedbackRequests('fr', NOW + 2);
        expect((await stateRow())[A]).toEqual({ question: 'F?', endsAt: NOW + 20, shownAt: NOW + 1 });
        expect(await drawerRows()).toHaveLength(1);
    });

    it('answered elsewhere: stamps answeredAt and marks the drawer row actioned, once', async () => {
        server.use(serverList(view(A, { endsAt: iso(NOW + 10) })));
        await syncFeedbackRequests('en', NOW);
        server.use(serverList(view(A, { endsAt: iso(NOW + 10), answered: true })));
        await expect(syncFeedbackRequests('en', NOW + 5)).resolves.toMatchObject({ answered: 1, newRows: 0 });
        expect((await stateRow())[A].answeredAt).toBe(NOW + 5);
        expect((await drawerRows()).map((r) => r.status)).toEqual(['actioned']);

        // Once stamped, a later sync neither re-stamps nor re-actions it.
        await expect(syncFeedbackRequests('en', NOW + 6)).resolves.toMatchObject({ answered: 0 });
        expect((await stateRow())[A].answeredAt).toBe(NOW + 5);
    });

    it('already answered on first sight: recorded, but no drawer row and nothing to action', async () => {
        server.use(
            serverList(
                view(A, { endsAt: iso(NOW + 10), answered: true }),
                view(B, { question: 'R?', endsAt: iso(NOW + 10) }),
            ),
        );
        await expect(syncFeedbackRequests('en', NOW)).resolves.toEqual({ ok: true, fetched: 2, newRows: 1, answered: 0 });
        expect((await stateRow())[A].answeredAt).toBe(NOW);
        expect((await drawerRows()).map((r) => r.source)).toEqual([feedbackRequestNotificationSource(B)]);
    });

    // The auto-show host is level-triggered off state writes.
    it('a sync with requests wakes state listeners', async () => {
        const listener = jest.fn();
        subscribeFeedbackRequestsState(listener);
        server.use(serverList(view(A)));
        await syncFeedbackRequests('en', NOW);
        expect(listener).toHaveBeenCalled();
    });
});

describe('ingestFeedbackRequests', () => {
    it('an empty list with nothing open locally writes nothing and wakes nobody', async () => {
        const listener = jest.fn();
        subscribeFeedbackRequestsState(listener);
        await expect(ingestFeedbackRequests([], NOW)).resolves.toEqual({ newRows: 0, answered: 0 });
        expect(await getSetting(FEEDBACK_REQUESTS_STATE_KEY)).toBeNull();
        expect(listener).not.toHaveBeenCalled();
    });

    it('an empty list with only ended entries locally still writes nothing', async () => {
        await setSetting(FEEDBACK_REQUESTS_STATE_KEY, JSON.stringify({ [A]: { question: 'Q', endsAt: NOW - 1 } }));
        const listener = jest.fn();
        subscribeFeedbackRequestsState(listener);
        const before = await getSetting(FEEDBACK_REQUESTS_STATE_KEY);
        await ingestFeedbackRequests([], NOW);
        expect(await getSetting(FEEDBACK_REQUESTS_STATE_KEY)).toBe(before);
        expect(listener).not.toHaveBeenCalled();
    });

    // The list carries LIVE requests only: one the server closed before its end date simply
    // disappears from it.
    it('closes an open local entry the list no longer carries, and it stops being a candidate', async () => {
        await ingestFeedbackRequests([req(A, { endsAt: NOW + 1000 })], NOW);
        await ingestFeedbackRequests([req(B, { endsAt: NOW + 1000 })], NOW + 10);
        const state = await stateRow();
        expect(state[A].endsAt).toBe(NOW + 10);
        expect(state[B].endsAt).toBe(NOW + 1000);
        expect(pickAutoShowCandidate(state, NOW + 11)).toBe(B);
    });

    it('an empty list closes every open local entry', async () => {
        await ingestFeedbackRequests([req(A, { endsAt: NOW + 1000 }), req(B, { endsAt: NOW + 2000 })], NOW);
        await ingestFeedbackRequests([], NOW + 5);
        const state = await stateRow();
        expect([state[A].endsAt, state[B].endsAt]).toEqual([NOW + 5, NOW + 5]);
        expect(pickAutoShowCandidate(state, NOW + 6)).toBeNull();
    });

    it('does not move the endsAt of an entry that had already ended', async () => {
        await ingestFeedbackRequests([req(A, { endsAt: NOW + 10 })], NOW);
        await ingestFeedbackRequests([req(B, { endsAt: NOW + 5000 })], NOW + 100);
        expect((await stateRow())[A].endsAt).toBe(NOW + 10);
    });

    it('a request that comes back gets its endsAt back, with no second drawer row', async () => {
        await ingestFeedbackRequests([req(A, { endsAt: NOW + 1000 })], NOW);
        await ingestFeedbackRequests([], NOW + 5);
        await ingestFeedbackRequests([req(A, { endsAt: NOW + 1000 })], NOW + 6);
        expect((await stateRow())[A].endsAt).toBe(NOW + 1000);
        expect(await drawerRows()).toHaveLength(1);
    });

    it('answered-since: an entry the device knew is marked answered and its row actioned; one it did not know gets no row', async () => {
        await ingestFeedbackRequests([req(A)], NOW);
        const result = await ingestFeedbackRequests([req(A, { answered: true }), req(B, { answered: true })], NOW + 7);
        expect(result).toEqual({ newRows: 0, answered: 1 });
        const state = await stateRow();
        expect([state[A].answeredAt, state[B].answeredAt]).toEqual([NOW + 7, NOW + 7]);
        expect((await drawerRows()).map((r) => [r.source, r.status])).toEqual([[feedbackRequestNotificationSource(A), 'actioned']]);
    });

    it('creates one row per new request', async () => {
        await expect(ingestFeedbackRequests([req(A), req(B)], NOW)).resolves.toEqual({ newRows: 2, answered: 0 });
        expect((await drawerRows()).map((r) => r.source)).toEqual([
            feedbackRequestNotificationSource(A),
            feedbackRequestNotificationSource(B),
        ]);
    });

    // "The state entry lands BEFORE the drawer row": hold the state write and see no row yet.
    it('writes the state entry before the drawer row', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const real = settingService.setSetting;
        restoreAfterTest(jest.spyOn(settingService, 'setSetting')).mockImplementation(async (key, value) => {
            if (key === FEEDBACK_REQUESTS_STATE_KEY) await gate;
            return real(key, value);
        });

        const pending = ingestFeedbackRequests([req(A)], NOW);
        for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
        expect(await drawerRows()).toEqual([]);

        release();
        await pending;
        expect(Object.keys(await readFeedbackRequestsState())).toEqual([A]);
        expect(await drawerRows()).toHaveLength(1);
    });

    // Documented contract: "a failure between the two can lose a row but never duplicate one".
    describe('when the state write fails', () => {
        const failOneStateWrite = () => {
            const real = settingService.setSetting;
            let failed = false;
            restoreAfterTest(jest.spyOn(settingService, 'setSetting')).mockImplementation(async (key, value) => {
                if (key === FEEDBACK_REQUESTS_STATE_KEY && !failed) {
                    failed = true;
                    throw new Error('state write failed');
                }
                return real(key, value);
            });
        };

        test.failing('DATA-U16a-1: no drawer row is created for an entry that never reached the state row', async () => {
            spyLogger();
            failOneStateWrite();
            await ingestFeedbackRequests([req(A)], NOW);
            expect(await getSetting(FEEDBACK_REQUESTS_STATE_KEY)).toBeNull();
            expect(await drawerRows()).toEqual([]);
        });

        it('today: the row is created anyway, so the retry duplicates it', async () => {
            spyLogger();
            failOneStateWrite();
            await ingestFeedbackRequests([req(A)], NOW);
            expect(await getSetting(FEEDBACK_REQUESTS_STATE_KEY)).toBeNull();
            expect(await drawerRows()).toHaveLength(1);

            await ingestFeedbackRequests([req(A)], NOW + 1);
            expect(Object.keys(await stateRow())).toEqual([A]);
            expect(await drawerRows()).toHaveLength(2);
        });
    });
});
