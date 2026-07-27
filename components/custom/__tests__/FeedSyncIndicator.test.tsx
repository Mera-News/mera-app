/* eslint-disable @typescript-eslint/no-require-imports */
// FeedSyncIndicator — the P8 loader contract.
//
// The one property that matters and that no integration test can prove cheaply:
// the indicator must be visible in the SAME render pass as the synchronous
// `reserveTask('feed-sync')` that `AppScheduler.trigger` performs before its
// first await. Everything here is driven by direct store mutations inside
// `act()`, which is exactly the "same JS tick" the pull gesture produces.
//
// FeedStatusShimmer is stubbed to a plain View exposing its `processing` prop:
// the real one pulls reanimated (useSharedValue/withRepeat/LinearTransition) and
// @expo/vector-icons, neither of which this repo mocks globally. The stub keeps
// the assertion on the thing the plan specifies — the visibility boolean — and
// immune to animation-mock drift.

import { act, render } from '@testing-library/react-native';
import React from 'react';

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

jest.mock('@/components/custom/for-you/FeedStatusShimmer', () => {
    const { View } = require('react-native');
    return {
        __esModule: true,
        default: ({ processing }: { processing: boolean }) => (
            <View testID="shimmer" accessibilityState={{ busy: processing }} />
        ),
    };
});

jest.mock('@/components/custom/ReauthBanner', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="reauth" /> };
});

jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (props: any) => <View {...props} /> };
});
jest.mock('@/components/ui/text', () => {
    const { Text: RNText } = require('react-native');
    return { Text: RNText };
});
jest.mock('@/components/ui/icon', () => {
    const { View } = require('react-native');
    return { Icon: (props: any) => <View {...props} />, AlertCircleIcon: 'AlertCircleIcon' };
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
import FeedSyncIndicator, { useFeedSyncRefresh } from '@/components/custom/FeedSyncIndicator';
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

function isVisible(getByTestId: (id: string) => any): boolean {
    return getByTestId('shimmer').props.accessibilityState.busy === true;
}

/** Minimal harness so `useFeedSyncRefresh` can be exercised without a screen. */
let lastRefresh: { refreshing: boolean; onRefresh: () => void };
function RefreshProbe({ onPullStart }: { onPullStart?: () => void }) {
    lastRefresh = useFeedSyncRefresh(onPullStart);
    return null;
}

describe('FeedSyncIndicator', () => {
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
        const { getByTestId } = render(<FeedSyncIndicator />);
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
        const { getByTestId } = render(<FeedSyncIndicator />);
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
        const { getByTestId } = render(<FeedSyncIndicator />);

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

    it('shows the offline notice only when disconnected, and never when notices are suppressed', () => {
        const { queryByText, rerender } = render(<FeedSyncIndicator />);
        expect(queryByText('feed.offlineCached')).toBeNull();

        act(() => {
            useNetworkStore.setState({ isConnected: false });
        });
        expect(queryByText('feed.offlineCached')).toBeTruthy();

        rerender(<FeedSyncIndicator showConnectivityNotices={false} />);
        expect(queryByText('feed.offlineCached')).toBeNull();
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
            });

        const { getByTestId } = render(
            <>
                <RefreshProbe />
                <FeedSyncIndicator />
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
        const trigger = jest.spyOn(AppScheduler, 'trigger').mockResolvedValue(undefined);
        useNetworkStore.setState({ isConnected: false });

        render(<RefreshProbe onPullStart={onPullStart} />);
        act(() => {
            lastRefresh.onRefresh();
        });

        expect(onPullStart).toHaveBeenCalledTimes(1);
        expect(trigger).not.toHaveBeenCalled();
    });

    it('does not flash the loader when the pull is a no-op — offline', () => {
        const trigger = jest.spyOn(AppScheduler, 'trigger').mockResolvedValue(undefined);
        useNetworkStore.setState({ isConnected: false });

        const { getByTestId } = render(
            <>
                <RefreshProbe />
                <FeedSyncIndicator />
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
        const trigger = jest.spyOn(AppScheduler, 'trigger').mockResolvedValue(undefined);
        AppScheduler.pauseTask('feed-sync');

        const { getByTestId } = render(
            <>
                <RefreshProbe />
                <FeedSyncIndicator />
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
        const trigger = jest.spyOn(AppScheduler, 'trigger').mockResolvedValue(undefined);

        const { getByTestId } = render(
            <>
                <RefreshProbe />
                <FeedSyncIndicator />
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
            return Promise.resolve(undefined);
        });

        render(
            <>
                <RefreshProbe />
                <FeedSyncIndicator />
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
