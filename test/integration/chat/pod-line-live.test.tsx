// The chat line for the paired server from the real runner: a failed sync and a failed command against
// the paired server, not a hand-set health. Only the server is faked, at the network edge.
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));
jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));

import '@/lib/scheduler/tasks/feed-sync-task';

import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import React from 'react';
import ChatThread from '@/components/custom/floating-chat/ChatThread';
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
import '@/lib/apollo-client';

const POD_LINE = "Can't reach your server.";
const TOKEN = 'pod-token-abcdef123456';

const Thread = () => (
  <ChatThread
    items={[]}
    isStreaming={false}
    onLoadOlder={() => {}}
    hasOlder={false}
    isLoadingOlder={false}
    showHistoryButton={false}
    onRevealHistory={() => {}}
    starterChips={[]}
    onChipPress={() => {}}
    blockedMessage={null}
    bannerBlocksInput={false}
    showUnblockControls={false}
    unblockPending={false}
    onRequestUnblock={() => {}}
    onRefreshBlockStatus={() => {}}
    isRefreshingBlockStatus={false}
    onSend={() => {}}
    isInputDisabled={false}
  />
);

let pod: ReturnType<typeof fakePod>;
const line = () => screen.queryByTestId('chat-service-line');

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
  await inferenceQueue.stop();
  AppScheduler.dispose();
  cleanupFeedSync();
});

it('a sync that fails shows the line, pressing it opens the server page, and the next good sync clears it', async () => {
  await render(<Thread />);
  await syncPod();
  expect(line()).toBeNull();

  pod.down();
  await act(async () => {
    await expect(syncPod()).rejects.toMatchObject({ code: 'unreachable' });
  });
  expect(within(line()!).getByText(POD_LINE)).toBeTruthy();
  await fireEvent.press(line()!);
  expect(router.push).toHaveBeenCalledWith('/logged-in/app_container/you/own-pod');

  pod.up();
  await act(async () => {
    await syncPod();
  });
  expect(line()).toBeNull();
});

it('a change that cannot be saved while the server is down shows the same line', async () => {
  await render(<Thread />);
  pod.down();
  await act(async () => {
    await expect(addFact('I follow cycling')).rejects.toMatchObject({ code: 'unreachable' });
  });
  expect(within(line()!).getByText(POD_LINE)).toBeTruthy();
});

it('unpairing clears it', async () => {
  await render(<Thread />);
  pod.down();
  await act(async () => {
    await expect(syncPod()).rejects.toBeDefined();
  });
  expect(line()).not.toBeNull();
  await act(async () => {
    await unpairPod();
  });
  expect(line()).toBeNull();
});

it('a version difference is not an outage', async () => {
  await render(<Thread />);
  pod.versions.schemaVersion += 1;
  await act(async () => {
    await expect(syncPod()).rejects.toMatchObject({ code: 'phone-old' });
  });
  expect(line()).toBeNull();
});

it('a server on an older version than the phone is not an outage either', async () => {
  await render(<Thread />);
  pod.versions.schemaVersion -= 1;
  await act(async () => {
    await expect(syncPod()).rejects.toMatchObject({ code: 'server-old' });
  });
  expect(line()).toBeNull();
});

it('a refused token shows the same line, as the Lines section says for a refused server', async () => {
  await render(<Thread />);
  pod.revoked.add(TOKEN);
  await act(async () => {
    await expect(syncPod()).rejects.toMatchObject({ code: 'refused' });
  });
  expect(within(line()!).getByText(POD_LINE)).toBeTruthy();
});
