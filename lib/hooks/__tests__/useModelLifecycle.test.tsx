// useModelLifecycle.test.tsx — unit tests for lib/hooks/useModelLifecycle.ts

const mockDisposeModel = jest.fn();
const mockInitBaseModel = jest.fn();
const mockIsModelDownloaded = jest.fn();

jest.mock('@/lib/mera-protocol-toolkit', () => ({
  disposeModel: (...args: unknown[]) => mockDisposeModel(...args),
  initBaseModel: (...args: unknown[]) => mockInitBaseModel(...args),
  isModelDownloaded: (...args: unknown[]) => mockIsModelDownloaded(...args),
}));

const mockInferenceQueueStart = jest.fn();
const mockInferenceQueueStop = jest.fn();
const mockInferenceQueueGetState = jest.fn();

jest.mock('@/lib/inference/InferenceQueue', () => ({
  inferenceQueue: {
    start: (...args: unknown[]) => mockInferenceQueueStart(...args),
    stop: (...args: unknown[]) => mockInferenceQueueStop(...args),
    getState: (...args: unknown[]) => mockInferenceQueueGetState(...args),
  },
}));

// We mock the Zustand store hooks with controllable values
let mockIsAppInitialized = false;
let mockIsOnDevice = false;
let mockModelState = 'not_downloaded';
const mockSetModelState = jest.fn();
const mockSetModelError = jest.fn();

jest.mock('@/lib/stores/app-state-store', () => ({
  useIsAppInitialized: () => mockIsAppInitialized,
}));

jest.mock('@/lib/stores/mera-protocol-store', () => ({
  useIsOnDeviceProcessing: () => mockIsOnDevice,
  useMeraProtocolStore: (selector: (s: { setModelState: jest.Mock; setModelError: jest.Mock }) => unknown) =>
    selector({ setModelState: mockSetModelState, setModelError: mockSetModelError }),
  useModelState: () => mockModelState,
}));

// Mock AppState from react-native
const mockAppStateAddEventListener = jest.fn();
const mockSubscriptionRemove = jest.fn();

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: (...args: unknown[]) => mockAppStateAddEventListener(...args),
  },
}));

import { renderHook, act } from '@testing-library/react-native';
import { useModelLifecycle } from '../useModelLifecycle';

describe('useModelLifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAppInitialized = false;
    mockIsOnDevice = false;
    mockModelState = 'not_downloaded';

    mockDisposeModel.mockResolvedValue(undefined);
    mockInitBaseModel.mockResolvedValue(undefined);
    mockIsModelDownloaded.mockResolvedValue(false);
    mockInferenceQueueStart.mockResolvedValue(undefined);
    mockInferenceQueueStop.mockResolvedValue(undefined);
    mockInferenceQueueGetState.mockReturnValue('stopped');

    mockAppStateAddEventListener.mockReturnValue({ remove: mockSubscriptionRemove });
  });

  describe('Effect 1: startup init + processing-mode reaction', () => {
    it('does nothing when app is not initialized', () => {
      mockIsAppInitialized = false;
      renderHook(() => useModelLifecycle());

      expect(mockInitBaseModel).not.toHaveBeenCalled();
      expect(mockDisposeModel).not.toHaveBeenCalled();
    });

    it('does nothing when isOnDevice=false and modelState is not ready', async () => {
      mockIsAppInitialized = true;
      mockIsOnDevice = false;
      mockModelState = 'not_downloaded';

      renderHook(() => useModelLifecycle());

      expect(mockInitBaseModel).not.toHaveBeenCalled();
      expect(mockDisposeModel).not.toHaveBeenCalled();
    });

    it('disposes model when switching to cloud (isOnDevice=false) and model is ready', async () => {
      mockIsAppInitialized = true;
      mockIsOnDevice = false;
      mockModelState = 'ready';
      mockDisposeModel.mockResolvedValue(undefined);

      renderHook(() => useModelLifecycle());

      // disposeModel is called async — wait for microtasks
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockDisposeModel).toHaveBeenCalled();
    });

    it('calls setModelState("downloaded") after successful dispose', async () => {
      mockIsAppInitialized = true;
      mockIsOnDevice = false;
      mockModelState = 'ready';

      renderHook(() => useModelLifecycle());

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockSetModelState).toHaveBeenCalledWith('downloaded');
    });

    it('loads model when isOnDevice=true and model is downloaded but not loaded', async () => {
      mockIsAppInitialized = true;
      mockIsOnDevice = true;
      mockModelState = 'downloaded';
      mockIsModelDownloaded.mockResolvedValue(true);

      renderHook(() => useModelLifecycle());

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockSetModelState).toHaveBeenCalledWith('loading');
      expect(mockInitBaseModel).toHaveBeenCalled();
      expect(mockSetModelState).toHaveBeenCalledWith('ready');
    });

    it('skips load when isOnDevice=true but model is not downloaded', async () => {
      mockIsAppInitialized = true;
      mockIsOnDevice = true;
      mockModelState = 'not_downloaded';
      mockIsModelDownloaded.mockResolvedValue(false);

      renderHook(() => useModelLifecycle());

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockInitBaseModel).not.toHaveBeenCalled();
    });

    it('skips load when model is already ready', async () => {
      mockIsAppInitialized = true;
      mockIsOnDevice = true;
      mockModelState = 'ready';

      renderHook(() => useModelLifecycle());

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockInitBaseModel).not.toHaveBeenCalled();
    });

    it('skips load when model is already loading', async () => {
      mockIsAppInitialized = true;
      mockIsOnDevice = true;
      mockModelState = 'loading';

      renderHook(() => useModelLifecycle());

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockInitBaseModel).not.toHaveBeenCalled();
    });

    it('calls setModelError when initBaseModel throws', async () => {
      mockIsAppInitialized = true;
      mockIsOnDevice = true;
      mockModelState = 'downloaded';
      mockIsModelDownloaded.mockResolvedValue(true);
      mockInitBaseModel.mockRejectedValue(new Error('llama load failed'));

      renderHook(() => useModelLifecycle());

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockSetModelError).toHaveBeenCalledWith('Error: llama load failed');
    });
  });

  describe('Effect 2: AppState listener', () => {
    it('registers AppState listener when app is initialized', () => {
      mockIsAppInitialized = true;

      renderHook(() => useModelLifecycle());

      expect(mockAppStateAddEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    });

    it('does NOT register AppState listener when app is not initialized', () => {
      mockIsAppInitialized = false;

      renderHook(() => useModelLifecycle());

      expect(mockAppStateAddEventListener).not.toHaveBeenCalled();
    });

    it('removes AppState subscription on unmount', () => {
      mockIsAppInitialized = true;

      const { unmount } = renderHook(() => useModelLifecycle());
      unmount();

      expect(mockSubscriptionRemove).toHaveBeenCalled();
    });

    it('reloads model on foreground return when model is not ready (on-device mode)', async () => {
      mockIsAppInitialized = true;
      mockIsOnDevice = true;
      mockModelState = 'downloaded'; // not ready, not loading

      let capturedListener: ((state: string) => Promise<void>) | null = null;
      mockAppStateAddEventListener.mockImplementation((_event, listener) => {
        capturedListener = listener as (state: string) => Promise<void>;
        return { remove: mockSubscriptionRemove };
      });
      mockIsModelDownloaded.mockResolvedValue(true);

      renderHook(() => useModelLifecycle());

      // Simulate foreground return
      await act(async () => {
        if (capturedListener) await capturedListener('active');
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockSetModelState).toHaveBeenCalledWith('loading');
      expect(mockInitBaseModel).toHaveBeenCalled();
    });

    it('does NOT reload on foreground when model is already ready', async () => {
      mockIsAppInitialized = true;
      mockIsOnDevice = true;
      mockModelState = 'ready'; // already ready

      let capturedListener: ((state: string) => Promise<void>) | null = null;
      mockAppStateAddEventListener.mockImplementation((_event, listener) => {
        capturedListener = listener as (state: string) => Promise<void>;
        return { remove: mockSubscriptionRemove };
      });

      renderHook(() => useModelLifecycle());

      await act(async () => {
        if (capturedListener) await capturedListener('active');
        await Promise.resolve();
      });

      expect(mockInitBaseModel).not.toHaveBeenCalled();
    });

    it('does NOT reload on foreground when in cloud mode (isOnDevice=false)', async () => {
      mockIsAppInitialized = true;
      mockIsOnDevice = false; // cloud mode
      mockModelState = 'downloaded';

      let capturedListener: ((state: string) => Promise<void>) | null = null;
      mockAppStateAddEventListener.mockImplementation((_event, listener) => {
        capturedListener = listener as (state: string) => Promise<void>;
        return { remove: mockSubscriptionRemove };
      });

      renderHook(() => useModelLifecycle());

      await act(async () => {
        if (capturedListener) await capturedListener('active');
        await Promise.resolve();
      });

      expect(mockInitBaseModel).not.toHaveBeenCalled();
    });

    it('does NOT reload when not going active (e.g. background)', async () => {
      mockIsAppInitialized = true;
      mockIsOnDevice = true;
      mockModelState = 'downloaded';

      let capturedListener: ((state: string) => Promise<void>) | null = null;
      mockAppStateAddEventListener.mockImplementation((_event, listener) => {
        capturedListener = listener as (state: string) => Promise<void>;
        return { remove: mockSubscriptionRemove };
      });

      renderHook(() => useModelLifecycle());

      await act(async () => {
        if (capturedListener) await capturedListener('background');
        await Promise.resolve();
      });

      expect(mockInitBaseModel).not.toHaveBeenCalled();
    });
  });

  describe('Effect 3: inference queue start/stop', () => {
    it('does nothing when app is not initialized', () => {
      mockIsAppInitialized = false;
      renderHook(() => useModelLifecycle());

      expect(mockInferenceQueueStart).not.toHaveBeenCalled();
    });

    it('starts inference queue when cloud mode (isOnDevice=false)', async () => {
      mockIsAppInitialized = true;
      mockIsOnDevice = false;
      mockModelState = 'not_downloaded';

      renderHook(() => useModelLifecycle());

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockInferenceQueueStart).toHaveBeenCalled();
    });

    it('starts inference queue when on-device and model is ready', async () => {
      mockIsAppInitialized = true;
      mockIsOnDevice = true;
      mockModelState = 'ready';

      renderHook(() => useModelLifecycle());

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockInferenceQueueStart).toHaveBeenCalled();
    });

    it('stops inference queue when on-device and model is not ready', async () => {
      mockIsAppInitialized = true;
      mockIsOnDevice = true;
      mockModelState = 'not_downloaded'; // not ready
      mockInferenceQueueGetState.mockReturnValue('running'); // queue was running

      renderHook(() => useModelLifecycle());

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockInferenceQueueStop).toHaveBeenCalled();
    });

    it('does NOT stop inference queue if already stopped', async () => {
      mockIsAppInitialized = true;
      mockIsOnDevice = true;
      mockModelState = 'not_downloaded';
      mockInferenceQueueGetState.mockReturnValue('stopped'); // already stopped

      renderHook(() => useModelLifecycle());

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockInferenceQueueStop).not.toHaveBeenCalled();
    });
  });
});
