/* eslint-disable @typescript-eslint/no-require-imports */
// The feed-sync loader contract (P8).
//
// The one property that matters and that no integration test can prove cheaply:
// the loader must be visible in the SAME render pass as the synchronous
// `reserveTask('feed-sync')` that `AppScheduler.trigger` performs before its
// first await. Everything here is driven by direct store mutations inside
// `act()`, which is exactly the "same JS tick" the pull gesture produces.
//
// `FeedSyncIndicator` used to export a COMPONENT that mounted the full-width
// status bar, and these tests rendered it to read that visibility boolean off a
// stubbed shimmer. The bar is gone; the same boolean is now `useFeedStatusMode()
// === 'processing'`, which is the exact same expression the bar's `processing`
// prop was fed. `StatusProbe` below reads it directly, so the assertions are
// unchanged and no longer depend on a component stub at all.
//
// One test went rather than being ported: "no longer renders an inline offline
// notice". It asserted something about a component that no longer exists, so it
// could only ever pass. The global OfflineBanner at the root layout still owns
// that band.

import { act, render } from '@testing-library/react-native';
import React from 'react';
import { View } from 'react-native';

// Stub the css-interop JSX wrapper layer. Its safe-area-context shim reads
// Platform.OS at module load, which is undefined under jest-expo's setup.
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return {
        jsx: ReactJSXRuntime.jsx,
        jsxs: ReactJSXRuntime.jsxs,
        Fragment: ReactJSXRuntime.Fragment,
    };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return {
        jsxDEV: ReactJSXRuntime.jsxDEV,
        Fragment: ReactJSXRuntime.Fragment,
    };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

// lib/database/index.ts instantiates a native SQLiteAdapter at import — the
// for-you store reaches it transitively via the selectors barrel.
jest.mock('@/lib/database', () => ({
    __esModule: true,
    default: {
        write: jest.fn((fn: () => Promise<void>) => fn()),
        get: jest.fn(() => ({ query: jest.fn(() => ({ fetch: jest.fn(async () => []) })) })),
    },
}));

/* eslint-disable import/first */
import { useFeedSyncRefresh } from '@/components/custom/FeedSyncIndicator';
import { useFeedStatusMode } from '@/lib/hooks/use-feed-status-mode';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useNetworkStore } from '@/lib/stores/network-store';
/* eslint-enable import/first */

const JOB_ID = 'job-1';

/** Register the job the scheduler store's setJobCompleted/setJobFailed need —
 *  both no-op when `state.jobs[jobId]` is absent. */
function addFeedSyncJob() {
    useSchedulerStore.getState().addJob({
        id: JOB_ID,
        taskName: 'feed-sync',
        status: 'pending',
        attempt: 0,
        maxAttempts: 3,
        createdAt: Date.now(),
    } as never);
}

/**
 * Stands in for the header status glyph. `mode === 'processing'` is exactly the
 * boolean the deleted bar received as its `processing` prop —
 * `schedulerRunning || isFeedProcessing` — so every assertion below still means
 * what it did.
 */
function StatusProbe() {
    const mode = useFeedStatusMode();
    return <View testID="shimmer" accessibilityState={{ busy: mode === 'processing' }} />;
}

function isVisible(getByTestId: (id: string) => any): boolean {
    return getByTestId('shimmer').props.accessibilityState.busy === true;
}

/** Minimal harness so `useFeedSyncRefresh` can be exercised without a screen. */
let lastRefresh: { refreshing: boolean; onRefresh: () => void };
function RefreshProbe({
    onPullStart,
    onPullAccepted,
}: {
    onPullStart?: () => void;
    onPullAccepted?: () => void;
}) {
    lastRefresh = useFeedSyncRefresh(onPullStart, onPullAccepted);
    return null;
}

describe('useFeedStatusMode — loader visibility', () => {
    beforeEach(() => {
        useSchedulerStore.setState({
            jobs: {},
            taskCurrentStatus: {},
            taskStartedAt: {},
            taskLastRun: {},
            taskProgress: {},
            runningCount: 0,
            failedCount: 0,
            pendingCount: 0,
        });
        useForYouStore.setState({
            syncStatusMessage: null,
            asyncJobPhase: 'idle',
            isDeviceProcessing: false,
            unscoredCount: 0,
            scoringError: null,
            dailyLimitResetAt: null,
            suggestions: [],
            articleCount: 0,
        } as never);
        useNetworkStore.setState({ isConnected: true });
        AppScheduler.resumeTask('feed-sync');
        jest.restoreAllMocks();
    });

    it('becomes visible in the same render pass as reserveTask, and hides on setJobCompleted', () => {
        const { getByTestId } = render(<StatusProbe />);
        expect(isVisible(getByTestId)).toBe(false);

        // The synchronous half of AppScheduler.trigger — everything that runs
        // before its first `await persistence.createJob(...)`.
        act(() => {
            useSchedulerStore.getState().reserveTask('feed-sync');
        });
        expect(isVisible(getByTestId)).toBe(true);

        act(() => {
            addFeedSyncJob();
            useSchedulerStore.getState().setJobCompleted(JOB_ID, Date.now());
        });
        expect(isVisible(getByTestId)).toBe(false);
    });

    it('does not treat the non-null "completed" status as running (=== running, not truthiness)', () => {
        const { getByTestId } = render(<StatusProbe />);
        act(() => {
            useSchedulerStore.setState({ taskCurrentStatus: { 'feed-sync': 'completed' } });
        });
        expect(isVisible(getByTestId)).toBe(false);

        act(() => {
            useSchedulerStore.setState({ taskCurrentStatus: { 'feed-sync': 'retrying' } });
        });
        expect(isVisible(getByTestId)).toBe(false);
    });

    it('stays visible while asyncJobPhase !== idle even after the scheduler job completes', () => {
        const { getByTestId } = render(<StatusProbe />);

        act(() => {
            useSchedulerStore.getState().reserveTask('feed-sync');
            addFeedSyncJob();
        });
        act(() => {
            useForYouStore.setState({ asyncJobPhase: 'relevance' } as never);
            useSchedulerStore.getState().setJobCompleted(JOB_ID, Date.now());
        });

        // The scheduler job is done but the cloud scoring tail outlives it.
        expect(useSchedulerStore.getState().taskCurrentStatus['feed-sync']).toBe('completed');
        expect(isVisible(getByTestId)).toBe(true);

        act(() => {
            useForYouStore.setState({ asyncJobPhase: 'idle' } as never);
        });
        expect(isVisible(getByTestId)).toBe(false);
    });

});

describe('useFeedSyncRefresh', () => {
    beforeEach(() => {
        useSchedulerStore.setState({
            jobs: {},
            taskCurrentStatus: {},
            taskStartedAt: {},
            runningCount: 0,
            pendingCount: 0,
        });
        // Reset for-you too: the indicator OR-s the store-derived flag into its
        // visibility, so a leftover non-idle asyncJobPhase from the block above
        // would look exactly like an indicator bug here.
        useForYouStore.setState({
            syncStatusMessage: null,
            asyncJobPhase: 'idle',
            isDeviceProcessing: false,
            unscoredCount: 0,
            scoringError: null,
            dailyLimitResetAt: null,
            suggestions: [],
            articleCount: 0,
        } as never);
        useNetworkStore.setState({ isConnected: true });
        AppScheduler.resumeTask('feed-sync');
        jest.restoreAllMocks();
    });

    it('triggers feed-sync on a pull and reflects the reservation as `refreshing`', () => {
        const trigger = jest
            .spyOn(AppScheduler, 'trigger')
            .mockImplementation(async (name: string) => {
                // Mirror the real synchronous half of trigger → _enqueueAndRun.
                useSchedulerStore.getState().reserveTask(name);
                return 'ran';
            });

        const { getByTestId } = render(
            <>
                <RefreshProbe />
                <StatusProbe />
            </>,
        );
        expect(lastRefresh.refreshing).toBe(false);

        act(() => {
            lastRefresh.onRefresh();
        });

        expect(trigger).toHaveBeenCalledWith('feed-sync');
        expect(lastRefresh.refreshing).toBe(true);
        expect(isVisible(getByTestId)).toBe(true);
    });

    it('calls onPullStart (header reveal) even when every guard short-circuits', () => {
        const onPullStart = jest.fn();
        const trigger = jest.spyOn(AppScheduler, 'trigger').mockResolvedValue('ran');
        useNetworkStore.setState({ isConnected: false });

        render(<RefreshProbe onPullStart={onPullStart} />);
        act(() => {
            lastRefresh.onRefresh();
        });

        expect(onPullStart).toHaveBeenCalledTimes(1);
        expect(trigger).not.toHaveBeenCalled();
    });

    it('calls onPullAccepted once the pull has cleared both guards', () => {
        const onPullAccepted = jest.fn();
        jest.spyOn(AppScheduler, 'trigger').mockResolvedValue('ran');

        render(<RefreshProbe onPullAccepted={onPullAccepted} />);
        act(() => {
            lastRefresh.onRefresh();
        });

        expect(onPullAccepted).toHaveBeenCalledTimes(1);
    });

    it('does not call onPullAccepted when offline', () => {
        const onPullAccepted = jest.fn();
        const trigger = jest.spyOn(AppScheduler, 'trigger').mockResolvedValue('ran');
        useNetworkStore.setState({ isConnected: false });

        render(<RefreshProbe onPullAccepted={onPullAccepted} />);
        act(() => {
            lastRefresh.onRefresh();
        });

        expect(onPullAccepted).not.toHaveBeenCalled();
        expect(trigger).not.toHaveBeenCalled();
    });

    it('does not call onPullAccepted when feed-sync is paused by the auth breaker', () => {
        const onPullAccepted = jest.fn();
        const trigger = jest.spyOn(AppScheduler, 'trigger').mockResolvedValue('ran');
        AppScheduler.pauseTask('feed-sync');

        render(<RefreshProbe onPullAccepted={onPullAccepted} />);
        act(() => {
            lastRefresh.onRefresh();
        });

        expect(onPullAccepted).not.toHaveBeenCalled();
        expect(trigger).not.toHaveBeenCalled();
    });

    it('still works when called with a single argument (onPullAccepted omitted)', () => {
        const trigger = jest
            .spyOn(AppScheduler, 'trigger')
            .mockImplementation(async (name: string) => {
                useSchedulerStore.getState().reserveTask(name);
                return 'ran';
            });

        render(<RefreshProbe />);
        expect(() => {
            act(() => {
                lastRefresh.onRefresh();
            });
        }).not.toThrow();

        expect(trigger).toHaveBeenCalledWith('feed-sync');
        expect(lastRefresh.refreshing).toBe(true);
    });

    it('does not flash the loader when the pull is a no-op — offline', () => {
        const trigger = jest.spyOn(AppScheduler, 'trigger').mockResolvedValue('ran');
        useNetworkStore.setState({ isConnected: false });

        const { getByTestId } = render(
            <>
                <RefreshProbe />
                <StatusProbe />
            </>,
        );
        act(() => {
            lastRefresh.onRefresh();
        });

        expect(trigger).not.toHaveBeenCalled();
        expect(lastRefresh.refreshing).toBe(false);
        expect(isVisible(getByTestId)).toBe(false);
    });

    it('does not flash the loader when the pull is a no-op — task paused by the auth breaker', () => {
        const trigger = jest.spyOn(AppScheduler, 'trigger').mockResolvedValue('ran');
        AppScheduler.pauseTask('feed-sync');

        const { getByTestId } = render(
            <>
                <RefreshProbe />
                <StatusProbe />
            </>,
        );
        act(() => {
            lastRefresh.onRefresh();
        });

        expect(trigger).not.toHaveBeenCalled();
        expect(lastRefresh.refreshing).toBe(false);
        expect(isVisible(getByTestId)).toBe(false);
    });

    it('skips a duplicate trigger while a run is already in flight, and adopts the spinner', () => {
        const trigger = jest.spyOn(AppScheduler, 'trigger').mockResolvedValue('ran');

        const { getByTestId } = render(
            <>
                <RefreshProbe />
                <StatusProbe />
            </>,
        );
        act(() => {
            useSchedulerStore.getState().reserveTask('feed-sync');
        });

        // A background run (60s tick / foreground kick / reconnect) lights the
        // header shimmer but must NOT drop the native pull spinner over the
        // list — there is no gesture behind it.
        expect(lastRefresh.refreshing).toBe(false);
        expect(isVisible(getByTestId)).toBe(true);

        act(() => {
            lastRefresh.onRefresh();
        });

        // Pulling during that run must not double-trigger (feed-sync is
        // exclusive), but the spinner is now the user's and holds for the run.
        expect(trigger).not.toHaveBeenCalled();
        expect(lastRefresh.refreshing).toBe(true);
        expect(isVisible(getByTestId)).toBe(true);
    });

    it('releases the spinner when the run ends, and does not re-raise it for the next background sync', () => {
        jest.spyOn(AppScheduler, 'trigger').mockImplementation(() => {
            useSchedulerStore.getState().reserveTask('feed-sync');
            return Promise.resolve('ran' as const);
        });

        render(
            <>
                <RefreshProbe />
                <StatusProbe />
            </>,
        );

        act(() => {
            lastRefresh.onRefresh();
        });
        expect(lastRefresh.refreshing).toBe(true);

        act(() => {
            useSchedulerStore.getState().clearTaskReservation('feed-sync');
        });
        expect(lastRefresh.refreshing).toBe(false);

        // A later background run must not resurrect the user's spinner.
        act(() => {
            useSchedulerStore.getState().reserveTask('feed-sync');
        });
        expect(lastRefresh.refreshing).toBe(false);
    });
});

// ── debounced pull ─────────────────────────────────────────────────────────
// trigger() now carries a short per-task debounce, so a second pull inside the
// window returns 'debounced' and never starts a run. The scheduler's running
// flag therefore never rises, and `refreshing` (schedulerRunning && userPulled)
// must not be left waiting on a run that is not coming.
describe('useFeedSyncRefresh — debounced pull', () => {
    // Same reset as the sibling block: `refreshing` is
    // `schedulerRunning && userPulled`, so a reserveTask left behind by an
    // earlier test reads exactly like this hook failing to release the control.
    beforeEach(() => {
        useSchedulerStore.setState({
            jobs: {},
            taskCurrentStatus: {},
            taskStartedAt: {},
            runningCount: 0,
            pendingCount: 0,
        });
        useNetworkStore.setState({ isConnected: true });
        AppScheduler.resumeTask('feed-sync');
        jest.restoreAllMocks();
    });

    it('releases the refresh control when the pull is debounced', async () => {
        jest.spyOn(AppScheduler, 'trigger').mockResolvedValue('debounced');

        render(<RefreshProbe />);
        await act(async () => {
            lastRefresh.onRefresh();
        });

        expect(lastRefresh.refreshing).toBe(false);
    });

    it('does not reserve the task or raise the spinner on a debounced pull', async () => {
        const trigger = jest
            .spyOn(AppScheduler, 'trigger')
            .mockResolvedValue('debounced');

        render(<RefreshProbe />);
        await act(async () => {
            lastRefresh.onRefresh();
        });

        expect(trigger).toHaveBeenCalledWith('feed-sync');
        expect(useSchedulerStore.getState().isRunning('feed-sync')).toBe(false);
        expect(lastRefresh.refreshing).toBe(false);
    });

    // The contrast that makes the test above mean something: an accepted pull
    // still holds the control down for the real run.
    it('still holds the control for a pull that is accepted', async () => {
        jest.spyOn(AppScheduler, 'trigger').mockImplementation(async (name: string) => {
            useSchedulerStore.getState().reserveTask(name);
            return 'ran';
        });

        render(<RefreshProbe />);
        await act(async () => {
            lastRefresh.onRefresh();
        });

        expect(lastRefresh.refreshing).toBe(true);
    });

    // The follow-on case: a scheduled sync starts moments after a debounced
    // pull. The control must not go down over a run the user never asked for
    // and cannot have caused.
    //
    // Note for anyone editing the hook: this passes with OR without the
    // explicit `setUserPulled(false)` on the debounced branch, because the
    // effect that clears userPulled on `!schedulerRunning` has already fired by
    // then. That was verified by removing the line. This test pins the
    // BEHAVIOUR, not that particular line.
    it('does not adopt a later background sync after a debounced pull', async () => {
        jest.spyOn(AppScheduler, 'trigger').mockResolvedValue('debounced');

        render(<RefreshProbe />);
        await act(async () => {
            lastRefresh.onRefresh();
        });
        expect(lastRefresh.refreshing).toBe(false);

        // A scheduled run starts a moment later, with no gesture behind it.
        await act(async () => {
            useSchedulerStore.getState().reserveTask('feed-sync');
        });

        expect(lastRefresh.refreshing).toBe(false);
    });

    // onPullAccepted fires before the trigger resolves, so a debounced pull has
    // already run the caller's side effects. That is deliberate and unchanged:
    // the Feed tab's card-eviction sweep is keyed to the user's intent, not to
    // whether this particular pull happened to win the debounce.
    it('still fires onPullAccepted for a debounced pull', async () => {
        jest.spyOn(AppScheduler, 'trigger').mockResolvedValue('debounced');
        const onPullAccepted = jest.fn();

        render(<RefreshProbe onPullAccepted={onPullAccepted} />);
        await act(async () => {
            lastRefresh.onRefresh();
        });

        expect(onPullAccepted).toHaveBeenCalled();
    });
});
