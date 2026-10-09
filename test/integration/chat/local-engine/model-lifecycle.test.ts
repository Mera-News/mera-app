// useModelLifecycle (lib/hooks/useModelLifecycle.ts): the on-device model's load and unload tied to
// processing mode, app initialisation and AppState, and the inference queue's start and stop.
// Real hook under renderHook, real toolkit, real queue; only llama.rn and expo-file-system faked,
// and AppState driven with setAppState.
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useModelLifecycle } from '@/lib/hooks/useModelLifecycle';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import { disposeModel, getModelState } from '@/lib/mera-protocol-toolkit';
import { useAppStateStore } from '@/lib/stores/app-state-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { setAppState } from '@/test/helpers';
import {
  fileSystemModule,
  installLlama,
  llamaReleases,
  resetChatModules,
  resetFileSystem,
  setProcessingMode,
} from '@/test/integration/chat/_helpers';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);

const initLlama = () => (jest.requireMock('llama.rn') as { initLlama: jest.Mock }).initLlama;
const protocol = () => useMeraProtocolStore.getState();

/** Marks the selected model as downloaded: the manifest isDownloaded reads. */
async function markDownloaded(): Promise<void> {
  const id = protocol().selectedModelId;
  await new fileSystemModule.File(fileSystemModule.Paths.cache, 'mera-models', id, 'manifest.json').write(
    JSON.stringify({ modelId: id, ready: true }),
  );
}

const settleTicks = () => new Promise((r) => setTimeout(r, 100));

beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  await disposeModel();
  // After the dispose, so the release counter starts at zero.
  installLlama(['unused']);
  initLlama().mockClear();
  // The store keeps the last test's mode; cloud is the default every test starts from.
  await setProcessingMode('cloud');
  protocol().setModelState('not_downloaded');
  useAppStateStore.getState().setAppInitialized(false);
  setAppState('active');
  await inferenceQueue.stop();
});

afterEach(async () => {
  await inferenceQueue.stop();
  useAppStateStore.getState().setAppInitialized(false);
});

describe('before the app is initialised', () => {
  it('loads nothing and starts no queue, even on-device with a downloaded model', async () => {
    await setProcessingMode('on-device');
    await markDownloaded();

    renderHook(() => useModelLifecycle());
    await settleTicks();

    expect(initLlama()).not.toHaveBeenCalled();
    expect(protocol().modelState).toBe('not_downloaded');
    expect(inferenceQueue.getState()).toBe('stopped');
  });

  it('loads the model as soon as the app reports initialised', async () => {
    await setProcessingMode('on-device');
    await markDownloaded();
    renderHook(() => useModelLifecycle());

    act(() => useAppStateStore.getState().setAppInitialized(true));

    await waitFor(() => expect(protocol().modelState).toBe('ready'));
    expect(initLlama()).toHaveBeenCalledTimes(1);
  });
});

describe('on-device mode', () => {
  beforeEach(async () => {
    await setProcessingMode('on-device');
    useAppStateStore.getState().setAppInitialized(true);
  });

  it('loads a downloaded model (loading then ready) and only then starts the queue', async () => {
    await markDownloaded();
    const states: string[] = [];
    const unsub = useMeraProtocolStore.subscribe((s) => {
      if (states.at(-1) !== s.modelState) states.push(s.modelState);
    });

    renderHook(() => useModelLifecycle());
    // Not ready yet: the queue (which needs llama.rn) has not started.
    expect(inferenceQueue.getState()).toBe('stopped');

    await waitFor(() => expect(protocol().modelState).toBe('ready'));
    unsub();
    expect(states).toEqual(['loading', 'ready']);
    expect(getModelState()).not.toBeNull();
    expect(initLlama()).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(inferenceQueue.getState()).toBe('running'));
  });

  it('does nothing when the model is not downloaded: no load, no queue', async () => {
    renderHook(() => useModelLifecycle());
    await settleTicks();

    expect(initLlama()).not.toHaveBeenCalled();
    expect(protocol().modelState).toBe('not_downloaded');
    expect(inferenceQueue.getState()).toBe('stopped');
  });

  it('records a load failure as the model error and leaves the queue stopped', async () => {
    await markDownloaded();
    initLlama().mockRejectedValueOnce(new Error('out of memory'));

    renderHook(() => useModelLifecycle());

    await waitFor(() => expect(protocol().modelState).toBe('error'));
    expect(protocol().modelError).toContain('out of memory');
    expect(getModelState()).toBeNull();
    expect(inferenceQueue.getState()).toBe('stopped');
  });

  it('does not load again while the model is ready', async () => {
    await markDownloaded();
    const { rerender } = renderHook(() => useModelLifecycle());
    await waitFor(() => expect(protocol().modelState).toBe('ready'));

    rerender({});
    await settleTicks();

    expect(initLlama()).toHaveBeenCalledTimes(1);
  });
});

describe('cloud mode', () => {
  it('starts the queue at once and never loads a model', async () => {
    await markDownloaded();
    useAppStateStore.getState().setAppInitialized(true);

    renderHook(() => useModelLifecycle());

    await waitFor(() => expect(inferenceQueue.getState()).toBe('running'));
    await settleTicks();
    expect(initLlama()).not.toHaveBeenCalled();
    expect(protocol().modelState).toBe('not_downloaded');
  });

  it('switching on-device -> cloud releases the resident model (state back to downloaded) and keeps the queue', async () => {
    await setProcessingMode('on-device');
    await markDownloaded();
    useAppStateStore.getState().setAppInitialized(true);
    renderHook(() => useModelLifecycle());
    await waitFor(() => expect(protocol().modelState).toBe('ready'));
    expect(llamaReleases()).toBe(0);

    act(() => protocol().setProcessingMode(ProcessingMode.Cloud));

    await waitFor(() => expect(protocol().modelState).toBe('downloaded'));
    expect(llamaReleases()).toBe(1);
    expect(getModelState()).toBeNull();
    expect(inferenceQueue.getState()).toBe('running');
  });

  it('switching cloud -> on-device with no downloaded model stops the queue and loads nothing', async () => {
    useAppStateStore.getState().setAppInitialized(true);
    renderHook(() => useModelLifecycle());
    await waitFor(() => expect(inferenceQueue.getState()).toBe('running'));

    act(() => protocol().setProcessingMode(ProcessingMode.OnDevice));

    await waitFor(() => expect(inferenceQueue.getState()).toBe('stopped'));
    expect(initLlama()).not.toHaveBeenCalled();
  });
});

describe('returning to the foreground', () => {
  it('reloads a model the OS invalidated (on-device, not ready, downloaded)', async () => {
    await setProcessingMode('on-device');
    await markDownloaded();
    useAppStateStore.getState().setAppInitialized(true);
    renderHook(() => useModelLifecycle());
    await waitFor(() => expect(protocol().modelState).toBe('ready'));
    await disposeModel();
    act(() => protocol().setModelState('downloaded'));
    initLlama().mockClear();

    setAppState('background');
    setAppState('active');

    await waitFor(() => expect(protocol().modelState).toBe('ready'));
    expect(initLlama()).toHaveBeenCalledTimes(1);
  });

  it('leaves a ready model alone', async () => {
    await setProcessingMode('on-device');
    await markDownloaded();
    useAppStateStore.getState().setAppInitialized(true);
    renderHook(() => useModelLifecycle());
    await waitFor(() => expect(protocol().modelState).toBe('ready'));
    initLlama().mockClear();

    setAppState('background');
    setAppState('active');
    await settleTicks();

    expect(initLlama()).not.toHaveBeenCalled();
  });

  it('does not load a model in cloud mode', async () => {
    await markDownloaded();
    useAppStateStore.getState().setAppInitialized(true);
    renderHook(() => useModelLifecycle());
    await waitFor(() => expect(inferenceQueue.getState()).toBe('running'));

    setAppState('active');
    await settleTicks();

    expect(initLlama()).not.toHaveBeenCalled();
  });

  it('stops listening once the hook unmounts', async () => {
    await setProcessingMode('on-device');
    await markDownloaded();
    useAppStateStore.getState().setAppInitialized(true);
    const { unmount } = renderHook(() => useModelLifecycle());
    await waitFor(() => expect(protocol().modelState).toBe('ready'));
    await disposeModel();
    protocol().setModelState('downloaded');
    initLlama().mockClear();
    unmount();

    setAppState('active');
    await settleTicks();

    expect(initLlama()).not.toHaveBeenCalled();
  });
});
