// Seam test for the device-side state row `feedback_requests_state`: the real setting service on
// the in-memory DB, the real serialized write chain, the real account-switch wipe.
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import * as settingService from '@/lib/database/services/setting-service';
import {
    FEEDBACK_REQUESTS_STATE_KEY,
    FEEDBACK_REQUEST_STATE_RETENTION_MS,
    __resetFeedbackRequestStateForTests,
    isFeedbackRequestEnded,
    markFeedbackRequestAnswered,
    markFeedbackRequestDismissed,
    markFeedbackRequestShown,
    parseFeedbackRequestsState,
    pickAutoShowCandidate,
    readFeedbackRequestsState,
    subscribeFeedbackRequestsState,
    updateFeedbackRequestsState,
} from '@/lib/feedback-requests/feedback-request-state';
import { clearAllStores } from '@/lib/stores';
import { useFakeClock } from '@/test/helpers';
import { A, B, NOW, restoreAfterTest, spyLogger } from './support';

const row = async () => JSON.parse((await getSetting(FEEDBACK_REQUESTS_STATE_KEY)) ?? '{}');

beforeEach(() => {
    __resetFeedbackRequestStateForTests();
});

describe('parseFeedbackRequestsState', () => {
    it('reads nothing from an empty, corrupt or non-object row', () => {
        expect(parseFeedbackRequestsState(null)).toEqual({});
        expect(parseFeedbackRequestsState(undefined)).toEqual({});
        expect(parseFeedbackRequestsState('')).toEqual({});
        expect(parseFeedbackRequestsState('{')).toEqual({});
        expect(parseFeedbackRequestsState('[1]')).toEqual({});
        expect(parseFeedbackRequestsState('"x"')).toEqual({});
        expect(parseFeedbackRequestsState('null')).toEqual({});
    });

    it('keeps valid entries, drops corrupt ones, and drops a bad stamp but keeps the entry', () => {
        const parsed = parseFeedbackRequestsState(
            JSON.stringify({
                [A]: { question: 'q', endsAt: 5, shownAt: 1, answeredAt: 2, dismissedAt: 3 },
                [B]: { question: 'q', endsAt: 'soon' },
                c: null,
                d: { endsAt: 5 },
                e: { question: 'q', endsAt: 5, shownAt: 'x', answeredAt: null },
                f: 'text',
            }),
        );
        expect(parsed).toEqual({
            [A]: { question: 'q', endsAt: 5, shownAt: 1, answeredAt: 2, dismissedAt: 3 },
            e: { question: 'q', endsAt: 5 },
        });
    });
});

describe('reading a corrupt or unreadable row', () => {
    it('a corrupt stored row reads as empty, and the next write starts clean', async () => {
        await setSetting(FEEDBACK_REQUESTS_STATE_KEY, '{{{ not json');
        await expect(readFeedbackRequestsState()).resolves.toEqual({});
        await markFeedbackRequestShown(A, NOW, { question: 'q', endsAt: NOW + 1000 });
        expect(await row()).toEqual({ [A]: { question: 'q', endsAt: NOW + 1000, shownAt: NOW } });
    });

    it('an unreadable row reads as empty and is reported', async () => {
        const logs = spyLogger();
        restoreAfterTest(jest.spyOn(settingService, 'getSetting')).mockRejectedValueOnce(new Error('read failed'));
        await expect(readFeedbackRequestsState()).resolves.toEqual({});
        expect(logs.capture).toHaveBeenCalledTimes(1);
        expect(logs.capture.mock.calls[0][1]).toMatchObject({ tags: { module: 'feedback-request-state', method: 'read' } });
    });
});

describe('updateFeedbackRequestsState', () => {
    // The task, the host and the modal all write this row; an unserialized read-modify-write
    // would lose one of the writers' changes.
    it('serializes concurrent writers so neither change is lost', async () => {
        await updateFeedbackRequestsState((s) => {
            s[A] = { question: 'q', endsAt: NOW + 1000 };
        }, NOW);
        await Promise.all([
            markFeedbackRequestShown(A, NOW + 1),
            updateFeedbackRequestsState((s) => {
                s[A].question = 'q2';
            }, NOW),
            markFeedbackRequestAnswered(A, NOW + 2),
        ]);
        expect((await row())[A]).toEqual({ question: 'q2', endsAt: NOW + 1000, shownAt: NOW + 1, answeredAt: NOW + 2 });
    });

    it('two concurrent writers adding different entries both land', async () => {
        await Promise.all([
            updateFeedbackRequestsState((s) => {
                s[A] = { question: 'a', endsAt: NOW + 1000 };
            }, NOW),
            updateFeedbackRequestsState((s) => {
                s[B] = { question: 'b', endsAt: NOW + 1000 };
            }, NOW),
        ]);
        expect(Object.keys(await row()).sort()).toEqual([A, B]);
    });

    it('resolves with the new state', async () => {
        const next = await updateFeedbackRequestsState((s) => {
            s[A] = { question: 'q', endsAt: NOW + 1000 };
        }, NOW);
        expect(next).toEqual({ [A]: { question: 'q', endsAt: NOW + 1000 } });
    });

    it('prunes entries that ended more than the retention window ago, keeps the boundary', async () => {
        await updateFeedbackRequestsState((s) => {
            s[A] = { question: 'old', endsAt: NOW - FEEDBACK_REQUEST_STATE_RETENTION_MS - 1 };
            s[B] = { question: 'edge', endsAt: NOW - FEEDBACK_REQUEST_STATE_RETENTION_MS };
            s.c = { question: 'recent', endsAt: NOW - 1 };
        }, NOW);
        expect(Object.keys(await row()).sort()).toEqual([B, 'c']);
    });

    it('prunes against the clock when no now is passed', async () => {
        await updateFeedbackRequestsState((s) => {
            s[A] = { question: 'old', endsAt: NOW - FEEDBACK_REQUEST_STATE_RETENTION_MS - 1 };
            s[B] = { question: 'recent', endsAt: NOW - 1 };
        }, NOW);
        useFakeClock(NOW + 10 * FEEDBACK_REQUEST_STATE_RETENTION_MS);
        await updateFeedbackRequestsState((s) => {
            s.c = { question: 'fresh', endsAt: NOW + 10 * FEEDBACK_REQUEST_STATE_RETENTION_MS + 1000 };
        });
        expect(Object.keys(await row())).toEqual(['c']);
    });

    it('notifies listeners after a write, and stops after unsubscribe', async () => {
        const listener = jest.fn();
        const unsubscribe = subscribeFeedbackRequestsState(listener);
        await updateFeedbackRequestsState(() => undefined, NOW);
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        await updateFeedbackRequestsState(() => undefined, NOW);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('a mutator returning false writes nothing and notifies nobody', async () => {
        const listener = jest.fn();
        subscribeFeedbackRequestsState(listener);
        const result = await updateFeedbackRequestsState(() => false, NOW);
        expect(result).toEqual({});
        expect(await getSetting(FEEDBACK_REQUESTS_STATE_KEY)).toBeNull();
        expect(listener).not.toHaveBeenCalled();
    });

    it('a mutator returning false leaves an existing row byte-identical', async () => {
        await updateFeedbackRequestsState((s) => {
            s[A] = { question: 'q', endsAt: NOW + 1000 };
        }, NOW);
        const before = await getSetting(FEEDBACK_REQUESTS_STATE_KEY);
        await updateFeedbackRequestsState((s) => {
            s[A].question = 'changed but discarded';
            return false;
        }, NOW);
        expect(await getSetting(FEEDBACK_REQUESTS_STATE_KEY)).toBe(before);
    });

    it('a throwing listener does not stop the others', async () => {
        const good = jest.fn();
        subscribeFeedbackRequestsState(() => {
            throw new Error('bad listener');
        });
        subscribeFeedbackRequestsState(good);
        await updateFeedbackRequestsState(() => undefined, NOW);
        expect(good).toHaveBeenCalledTimes(1);
    });

    it('a failed write reports, resolves with the previous state, wakes nobody and does not poison the chain', async () => {
        const logs = spyLogger();
        await updateFeedbackRequestsState((s) => {
            s[A] = { question: 'q', endsAt: NOW + 1000 };
        }, NOW);
        const listener = jest.fn();
        subscribeFeedbackRequestsState(listener);

        restoreAfterTest(jest.spyOn(settingService, 'setSetting')).mockRejectedValueOnce(new Error('write failed'));
        const result = await updateFeedbackRequestsState((s) => {
            delete s[A];
        }, NOW);

        expect(result[A]).toBeDefined();
        expect(await row()).toHaveProperty(A);
        expect(listener).not.toHaveBeenCalled();
        expect(logs.capture.mock.calls[0][1]).toMatchObject({ tags: { module: 'feedback-request-state', method: 'write' } });

        await markFeedbackRequestShown(A, NOW);
        expect((await row())[A].shownAt).toBe(NOW);
    });
});

describe('no memory mirror', () => {
    // A mirror would outlive the account-switch wipe and hand the previous account's stamps to the next.
    it('after clearAllStores the state reads empty, with the listeners still attached', async () => {
        await updateFeedbackRequestsState((s) => {
            s[A] = { question: 'q', endsAt: NOW + 1000, shownAt: NOW, answeredAt: NOW };
        }, NOW);
        await expect(readFeedbackRequestsState()).resolves.toHaveProperty(A);

        await clearAllStores();

        await expect(readFeedbackRequestsState()).resolves.toEqual({});
        expect(await getSetting(FEEDBACK_REQUESTS_STATE_KEY)).toBeNull();
        expect(pickAutoShowCandidate(await readFeedbackRequestsState(), NOW)).toBeNull();
    });

    it('a read sees a write queued just before it', async () => {
        void updateFeedbackRequestsState((s) => {
            s[A] = { question: 'q', endsAt: NOW + 1000 };
        }, NOW);
        await expect(readFeedbackRequestsState()).resolves.toHaveProperty(A);
    });
});

describe('stamps', () => {
    beforeEach(async () => {
        await updateFeedbackRequestsState((s) => {
            s[A] = { question: 'q', endsAt: NOW + 1000 };
        }, NOW);
    });

    it('shownAt: first presentation wins', async () => {
        await expect(markFeedbackRequestShown(A, NOW + 1)).resolves.toBe(true);
        await markFeedbackRequestShown(A, NOW + 2);
        expect((await row())[A].shownAt).toBe(NOW + 1);
    });

    it('shownAt on an unknown id: false without a seed, created from the seed with one', async () => {
        await expect(markFeedbackRequestShown(B, NOW)).resolves.toBe(false);
        expect((await row())[B]).toBeUndefined();
        await expect(markFeedbackRequestShown(B, NOW, { question: 'seeded', endsAt: NOW + 5 })).resolves.toBe(true);
        expect((await row())[B]).toEqual({ question: 'seeded', endsAt: NOW + 5, shownAt: NOW });
    });

    it('shownAt ignores the seed for a known entry', async () => {
        await markFeedbackRequestShown(A, NOW + 1, { question: 'other', endsAt: 5 });
        expect((await row())[A]).toEqual({ question: 'q', endsAt: NOW + 1000, shownAt: NOW + 1 });
    });

    it('dismissedAt: first wins, never after an answer, unknown ids ignored', async () => {
        await markFeedbackRequestDismissed(A, NOW + 1);
        await markFeedbackRequestDismissed(A, NOW + 2);
        expect((await row())[A].dismissedAt).toBe(NOW + 1);
        await markFeedbackRequestDismissed(B, NOW);
        expect((await row())[B]).toBeUndefined();

        await updateFeedbackRequestsState((s) => {
            s[B] = { question: 'q', endsAt: NOW + 1000, answeredAt: NOW };
        }, NOW);
        await markFeedbackRequestDismissed(B, NOW + 3);
        expect((await row())[B].dismissedAt).toBeUndefined();
    });

    it('answeredAt: first wins, unknown ids ignored', async () => {
        await markFeedbackRequestAnswered(A, NOW + 1);
        await markFeedbackRequestAnswered(A, NOW + 2);
        expect((await row())[A].answeredAt).toBe(NOW + 1);
        await markFeedbackRequestAnswered(B, NOW);
        expect((await row())[B]).toBeUndefined();
    });

    it('answering after a dismissal still stamps answeredAt and keeps dismissedAt', async () => {
        await markFeedbackRequestDismissed(A, NOW + 1);
        await markFeedbackRequestAnswered(A, NOW + 2);
        expect((await row())[A]).toMatchObject({ dismissedAt: NOW + 1, answeredAt: NOW + 2 });
    });
});

describe('pickAutoShowCandidate and isFeedbackRequestEnded', () => {
    it('skips shown, answered, dismissed and ended; picks the one closing soonest', () => {
        const state = {
            shown: { question: 'q', endsAt: NOW + 10, shownAt: NOW },
            answered: { question: 'q', endsAt: NOW + 10, answeredAt: NOW },
            dismissed: { question: 'q', endsAt: NOW + 10, dismissedAt: NOW },
            ended: { question: 'q', endsAt: NOW },
            later: { question: 'q', endsAt: NOW + 500 },
            sooner: { question: 'q', endsAt: NOW + 100 },
        };
        expect(pickAutoShowCandidate(state, NOW)).toBe('sooner');
        expect(pickAutoShowCandidate({}, NOW)).toBeNull();
    });

    it('isFeedbackRequestEnded is inclusive of endsAt', () => {
        expect(isFeedbackRequestEnded({ endsAt: NOW }, NOW)).toBe(true);
        expect(isFeedbackRequestEnded({ endsAt: NOW + 1 }, NOW)).toBe(false);
    });

    it('uses the clock when no now is passed', () => {
        useFakeClock(NOW);
        expect(pickAutoShowCandidate({ x: { question: 'q', endsAt: NOW + 1 } })).toBe('x');
        expect(pickAutoShowCandidate({ x: { question: 'q', endsAt: NOW } })).toBeNull();
        expect(isFeedbackRequestEnded({ endsAt: NOW })).toBe(true);
    });
});
