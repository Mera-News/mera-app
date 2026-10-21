// CH13 through its real trigger: useModelLifecycle effect 3 calls inferenceQueue.stop() when the
// model leaves 'ready' and inferenceQueue.start() when it returns, both fire-and-forget. A model
// reload while a job's handler is running therefore restarts the queue under that job, and the job
// runs again (see jobs/queue-restart.test.ts for the queue on its own).
//
// Real hook under renderHook, real toolkit, real queue and DB; only llama.rn, the built-in model and
// expo-file-system are faked, and AppState is driven with setAppState. Real timers: nothing here waits on the clock.
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useModelLifecycle } from '@/lib/hooks/useModelLifecycle';
import { enqueueJob } from '@/lib/database/services/inference-job-service';
import { inferenceQueue, __setJobHandlerForTests } from '@/lib/inference/InferenceQueue';
import { disposeModel, RELEVANCE_MODEL } from '@/lib/mera-protocol-toolkit';
import { useAppStateStore } from '@/lib/stores/app-state-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { setAppState } from '@/test/helpers';
import { placeDownloadedModel } from '@/test/helpers/fs';
import {
  installLlama,
  resetChatModules,
  resetFileSystem,
  setProcessingMode,
} from '@/test/integration/chat/_helpers';
import { hold, jobRow } from '../inference/kit';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

const initLlama = () => (jest.requireMock('llama.rn') as { initLlama: jest.Mock }).initLlama;
const protocol = () => useMeraProtocolStore.getState();
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

async function markDownloaded(): Promise<void> {
  placeDownloadedModel(RELEVANCE_MODEL.modelId);
}

async function stopQueue(): Promise<void> {
  if (inferenceQueue.getState() === 'stopped') return;
  await Promise.race([inferenceQueue.stop(), settle(2_000)]);
}

beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  await disposeModel();
  installLlama(['unused']);
  initLlama().mockClear();
  await setProcessingMode('on-device');
  protocol().setModelState('not_downloaded');
  useAppStateStore.getState().setAppInitialized(false);
  setAppState('active');
  inferenceQueue.__resetTypeGatesForTests();
  await stopQueue();
});

afterEach(async () => {
  __setJobHandlerForTests('persona_summary', undefined);
  await stopQueue();
  useAppStateStore.getState().setAppInitialized(false);
});

/** On-device, model ready, queue running with one job's handler held open. Then the OS invalidates
 *  the model (dispose, state back to 'downloaded') and a foreground return reloads it: the model
 *  leaves 'ready' and comes back while the job is still running. Returns how often the handler ran. */
async function reloadModelWhileJobRuns(): Promise<{ runs: number; status: string | undefined }> {
  await markDownloaded();
  useAppStateStore.getState().setAppInitialized(true);
  renderHook(() => useModelLifecycle());
  await waitFor(() => expect(protocol().modelState).toBe('ready'));
  await waitFor(() => expect(inferenceQueue.getState()).toBe('running'));

  const job = hold();
  __setJobHandlerForTests('persona_summary', job.handler);
  const id = await enqueueJob('persona_summary', {});
  inferenceQueue.notify();
  await job.started;

  await disposeModel();
  act(() => protocol().setModelState('downloaded'));
  setAppState('background');
  setAppState('active');
  await waitFor(() => expect(protocol().modelState).toBe('ready'));
  // The reload's start() and a second loop's first dequeue get real time to run.
  await settle();

  job.release();
  await waitFor(async () => expect((await jobRow(id))?.status).toBe('done'));
  await settle();

  return { runs: job.calls.length, status: (await jobRow(id))?.status };
}

describe('a model reload while a job is running', () => {
  test('CH13: a model reload mid-job does not run the job again', async () => {
    const { runs, status } = await reloadModelWhileJobRuns();

    expect(status).toBe('done');
    expect(runs).toBe(1);
  });

});
