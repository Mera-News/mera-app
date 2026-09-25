/**
 * THE STUCK-TOAST REGRESSION, against a REAL WatermelonDB (in-memory LokiJS),
 * the real schema, the real InferenceJob model and combo-pass-service's real
 * query. Nothing about the count is faked.
 *
 * On device the "Updating all facts" toast never closed after all 21
 * topic_combo jobs were done. The jobs are never deleted when they finish:
 * each one goes pending -> running -> done by an UPDATE, and the combo handler
 * marks siblings done in back-to-back writes. A count observable that misses
 * the LAST of those writes stays above 0 forever, and so does the toast.
 */
import React from 'react';
import { act, render } from '@testing-library/react-native';

jest.mock('@/lib/database', () => {
    const { Database: DB, Model: M } = require('@nozbe/watermelondb');
    const Loki = require('@nozbe/watermelondb/adapters/lokijs').default;
    const schema = require('@/lib/database/schema').default;
    const InferenceJob = require('@/lib/database/models/InferenceJob').default;
    // The service resolves these collections at import; only inference_jobs
    // is exercised, so bare models stand in for the rest.
    const bare = (table: string) =>
        class extends M {
            static table = table;
        };
    const adapter = new Loki({
        schema,
        useWebWorker: false,
        useIncrementalIndexedDB: false,
        dbName: 'facts-combo-count-test',
        // Loki autosaves every 500ms by default; that interval keeps jest alive
        // forever after the suite passes (no open handle is reported).
        extraLokiOptions: { autosave: false },
    });
    return {
        __esModule: true,
        default: new DB({
            adapter,
            modelClasses: [
                InferenceJob,
                bare('topics'),
                bare('facts'),
                bare('settings'),
                bare('tracked_stories'),
            ],
        }),
    };
});
// The service's other imports reach the database index or the network; none of
// them is on the count path.
jest.mock('@/lib/database/services/fact-service', () => ({}));
jest.mock('@/lib/database/services/setting-service', () => ({}));
jest.mock('@/lib/database/services/topic-service', () => ({}));
jest.mock('@/lib/database/services/topic-decline-service', () => ({}));
jest.mock('@/lib/database/services/article-suggestion-service', () => ({}));
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), captureException: jest.fn() },
}));
jest.mock('react-native-reanimated', () => {
    const { View } = require('react-native');
    const R = require('react');
    return {
        __esModule: true,
        default: { View: R.forwardRef((p: any, ref: any) => R.createElement(View, { ...p, ref })) },
        Easing: { linear: 'linear' },
        useSharedValue: (initial: number) => {
            const { useRef } = require('react');
            return useRef({ value: initial }).current;
        },
        useAnimatedStyle: (fn: () => unknown) => fn(),
        useReducedMotion: () => false,
        withRepeat: (v: unknown) => v,
        withTiming: (v: unknown) => v,
        cancelAnimation: () => undefined,
    };
});
jest.mock('@/components/ui/toast', () => {
    const R = require('react');
    const { View, Text } = require('react-native');
    return {
        Toast: (p: any) => R.createElement(View, null, p.children),
        ToastTitle: (p: any) => R.createElement(Text, null, p.children),
        ToastDescription: (p: any) => R.createElement(Text, null, p.children),
    };
});
jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

import database from '@/lib/database';
import type InferenceJobModel from '@/lib/database/models/InferenceJob';
import FactsComboToast, { FACTS_COMBO_TOAST_ID } from '../FactsComboToast';
import { observeActiveComboJobCount } from '../facts-combo-source';
import { closeAll, isActive, resetToastQueue } from '@/lib/toast/toast-queue';

const jobs = () => database.get<InferenceJobModel>('inference_jobs');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function seedPending(n: number): Promise<InferenceJobModel[]> {
    const created: InferenceJobModel[] = [];
    await database.write(async () => {
        for (let i = 0; i < n; i += 1) {
            created.push(
                await jobs().create((job) => {
                    job.jobType = 'topic_combo';
                    job.status = 'pending';
                    job.priority = 15;
                    job.payload = { factId: `f${i}`, passId: 'p1' };
                    job.attempts = 0;
                    job.maxAttempts = 3;
                }),
            );
        }
    });
    return created;
}

/** The handler's shape: each job running, then done, one write each, back to
 *  back. Status UPDATES only; nothing is deleted. */
async function finishAllByStatus(rows: InferenceJobModel[]): Promise<void> {
    for (const row of rows) {
        await database.write(async () => {
            await row.update((job) => {
                job.status = 'running';
            });
        });
        await database.write(async () => {
            await row.update((job) => {
                job.status = 'done';
            });
        });
    }
}

async function wipe(): Promise<void> {
    await database.write(async () => {
        await database.unsafeResetDatabase();
    });
}

beforeEach(async () => {
    resetToastQueue();
    await wipe();
});

afterEach(() => {
    act(() => closeAll());
});

describe('facts-combo count, real database', () => {
    it('reaches 0 when 21 jobs finish through STATUS changes only (no deletes)', async () => {
        const rows = await seedPending(21);
        const seen: number[] = [];
        const sub = observeActiveComboJobCount().subscribe((n) => seen.push(n));
        await sleep(400);
        expect(seen[seen.length - 1]).toBe(21);

        await finishAllByStatus(rows);
        await sleep(800);
        sub.unsubscribe();

        expect(await jobs().query().fetchCount()).toBe(21); // nothing deleted
        expect(seen[seen.length - 1]).toBe(0);
    });

    it('closes the toast when the last job is marked done', async () => {
        const rows = await seedPending(21);
        render(<FactsComboToast />);
        await act(async () => {
            await sleep(400);
        });
        expect(isActive(FACTS_COMBO_TOAST_ID)).toBe(true);

        await act(async () => {
            await finishAllByStatus(rows);
            await sleep(800);
        });
        expect(isActive(FACTS_COMBO_TOAST_ID)).toBe(false);
    });

    it('after a relaunch with jobs pending, shows again and still closes at the end', async () => {
        const rows = await seedPending(5);
        // First session: shows, then the app is killed mid-pass.
        const first = render(<FactsComboToast />);
        await act(async () => {
            await sleep(400);
        });
        expect(isActive(FACTS_COMBO_TOAST_ID)).toBe(true);
        first.unmount();
        act(() => resetToastQueue());

        // Relaunch: rows still on disk, some already running.
        await database.write(async () => {
            await rows[0].update((job) => {
                job.status = 'running';
            });
        });
        render(<FactsComboToast />);
        await act(async () => {
            await sleep(400);
        });
        expect(isActive(FACTS_COMBO_TOAST_ID)).toBe(true);

        await act(async () => {
            await finishAllByStatus(rows);
            await sleep(800);
        });
        expect(isActive(FACTS_COMBO_TOAST_ID)).toBe(false);
    });
});
