// The feed's "can't reach your server" line from the real runner: a failed sync and a failed command
// against the paired server, not a hand-set health. Only the server is faked, at the network edge.
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));
jest.mock('react-native-reanimated', () => {
  const { View, Text } = require('react-native');
  const R = require('react');
  return {
    __esModule: true,
    default: { View, Text },
    Easing: { bezier: () => () => 0, linear: () => 0, inOut: () => () => 0, out: () => () => 0, in: () => () => 0, ease: () => 0, cubic: () => 0 },
    FadeInDown: {},
    FadeOutUp: {},
    useReducedMotion: () => true,
    useSharedValue: (v: unknown) => R.useRef({ value: v, set(n: unknown) { this.value = n; } }).current,
    useAnimatedStyle: () => ({}),
    // The Mera mark animates once unpairing starts a sync with Mera.
    makeMutable: (v: unknown) => ({ value: v }),
    withTiming: (v: unknown) => v,
    withRepeat: (v: unknown) => v,
    withSequence: (...v: unknown[]) => v[0],
    cancelAnimation: () => {},
  };
});
jest.mock('@/lib/mera-protocol-toolkit/core/systemRequirements', () => ({
  checkRequirements: jest.fn(() => Promise.resolve({ supported: false })),
}));

import '@/lib/scheduler/tasks/feed-sync-task';

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import React from 'react';
import { DashboardStatsCard } from '@/components/custom/for-you/DashboardStatsCard';
import { resetStatusCard } from '@/components/custom/for-you/feed-status-card';
import { _resetForTests as resetBreaker } from '@/lib/auth-failure-breaker';
import { addFact } from '@/lib/database/services/fact-service';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import { unpairPod } from '@/lib/own-services/pod-pairing';
import { enterPodMode, leavePodMode, syncPod } from '@/lib/own-services/pod-runner';
import { resetPodHealth } from '@/lib/own-services/pod-health';
import { forgetPairing, podState, savePairing } from '@/lib/own-services/pod-state';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { resetToastQueue } from '@/lib/toast/toast-queue';
import { fakePod, initI18nEn, podPairing, setAppState } from '@/test/helpers';
import { cleanupFeedSync, resetFeedSyncMemory } from '@/test/integration/data/feed-sync/steps/support';
import { resetScheduler } from '@/test/integration/data/scheduler/core/support';

const H = { includeHiddenElements: true } as const;
const POD_LINE = "Can't reach your server.";
const TOKEN = 'pod-token-abcdef123456';

let pod: ReturnType<typeof fakePod>;
const lead = () => screen.queryByTestId('feed-status-lead', H);
const row = () => screen.queryByTestId('feed-status-service-row', H);

beforeAll(async () => {
  await initI18nEn();
  jest.spyOn(console, 'info').mockImplementation(() => {});
});
beforeEach(async () => {
  resetScheduler();
  resetBreaker();
  resetFeedSyncMemory();
  resetPodHealth();
  resetToastQueue();
  podState.resetMemory();
  setAppState('active');
  (router.push as jest.Mock).mockClear();
  pod = fakePod({ token: TOKEN });
  await savePairing(podPairing({ token: TOKEN }));
  await enterPodMode();
});
afterEach(async () => {
  await leavePodMode();
  await forgetPairing();
  resetToastQueue();
  resetStatusCard();
  await inferenceQueue.stop();
  AppScheduler.dispose();
  cleanupFeedSync();
});

it('a sync that fails leads the card with the line, opens the server page, and the next good sync clears it', async () => {
  await render(<DashboardStatsCard testID="c" />);
  await syncPod();
  expect(screen.queryByText(POD_LINE, H)).toBeNull();

  pod.down();
  await act(async () => {
    await expect(syncPod()).rejects.toMatchObject({ code: 'unreachable' });
  });
  expect(lead()).toHaveTextContent(POD_LINE);
  await fireEvent.press(screen.getByTestId('c-toggle', H));
  await fireEvent.press(row()!);
  expect(router.push).toHaveBeenCalledWith('/logged-in/app_container/you/own-pod');

  pod.up();
  await act(async () => {
    await syncPod();
  });
  expect(screen.queryByText(POD_LINE, H)).toBeNull();
});

it('a change that cannot be saved while the server is down shows the same line', async () => {
  await render(<DashboardStatsCard testID="c" />);
  pod.down();
  await act(async () => {
    await expect(addFact('I follow cycling')).rejects.toMatchObject({ code: 'unreachable' });
  });
  expect(lead()).toHaveTextContent(POD_LINE);
});

it('unpairing clears it', async () => {
  await render(<DashboardStatsCard testID="c" />);
  pod.down();
  await act(async () => {
    await expect(syncPod()).rejects.toBeDefined();
  });
  expect(lead()).toHaveTextContent(POD_LINE);
  await act(async () => {
    await unpairPod();
  });
  expect(screen.queryByText(POD_LINE, H)).toBeNull();
});

it('a version difference is not an outage', async () => {
  await render(<DashboardStatsCard testID="c" />);
  pod.versions.schemaVersion += 1;
  await act(async () => {
    await expect(syncPod()).rejects.toMatchObject({ code: 'phone-old' });
  });
  expect(screen.queryByText(POD_LINE, H)).toBeNull();
});

it('a server on an older version than the phone is not an outage either', async () => {
  await render(<DashboardStatsCard testID="c" />);
  pod.versions.schemaVersion -= 1;
  await act(async () => {
    await expect(syncPod()).rejects.toMatchObject({ code: 'server-old' });
  });
  expect(screen.queryByText(POD_LINE, H)).toBeNull();
});

it('a refused token shows the same line, as the Lines section says for a refused server', async () => {
  await render(<DashboardStatsCard testID="c" />);
  pod.revoked.add(TOKEN);
  await act(async () => {
    await expect(syncPod()).rejects.toMatchObject({ code: 'refused' });
  });
  expect(lead()).toHaveTextContent(POD_LINE);
});
