// useModelLifecycle — manages on-device LLM model loading/unloading tied to app lifecycle.
// Loads the model on startup (if mera protocol enabled + model downloaded),
// keeps it resident while foregrounded, and disposes it on background.

import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { disposeModel, initBaseModel, isModelDownloaded } from '@/lib/mera-protocol-toolkit';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import { useIsAppInitialized } from '@/lib/stores/app-state-store';
import {
  useIsOnDeviceProcessing,
  useMeraProtocolStore,
  useModelState,
} from '@/lib/stores/mera-protocol-store';

export function useModelLifecycle(): void {
  const isAppInitialized = useIsAppInitialized();
  const isOnDevice = useIsOnDeviceProcessing();
  const modelState = useModelState();
  const setModelState = useMeraProtocolStore((s) => s.setModelState);
  const setModelError = useMeraProtocolStore((s) => s.setModelError);

  // Refs for stale-closure safety inside the AppState listener
  const onDeviceRef = useRef(isOnDevice);
  const modelStateRef = useRef(modelState);
  useEffect(() => {
    onDeviceRef.current = isOnDevice;
  }, [isOnDevice]);
  useEffect(() => {
    modelStateRef.current = modelState;
  }, [modelState]);

  // Effect 1: startup init + processing-mode reaction.
  // Intentionally omits modelState from deps — we only want to re-run when the
  // processing mode changes, not on every model state transition.
  useEffect(() => {
    if (!isAppInitialized) return;

    if (!isOnDevice) {
      // Switched to cloud — dispose if model is resident
      if (modelState === 'ready') {
        disposeModel()
          .then(() => setModelState('downloaded'))
          .catch(() => {});
      }
      return;
    }

    // On-device mode — load if model is downloaded but not yet resident
    if (modelState === 'ready' || modelState === 'loading') return;

    isModelDownloaded()
      .then((downloaded) => {
        if (!downloaded) return;
        setModelState('loading');
        initBaseModel()
          .then(() => setModelState('ready'))
          .catch((err) => setModelError(String(err)));
      })
      .catch(() => {});
  }, [isAppInitialized, isOnDevice]); // eslint-disable-line react-hooks/exhaustive-deps

  // Effect 2: AppState listener — verify model is still usable on foreground return.
  // The model stays resident while backgrounded (iOS will terminate the app if it
  // needs the memory, which results in a fresh start). This avoids the expensive
  // dispose→reload cycle and a race condition where foreground fires before
  // disposal completes, leaving the model stuck in a 'downloaded' state with no
  // reload trigger.
  useEffect(() => {
    if (!isAppInitialized) return;

    const subscription = AppState.addEventListener('change', async (nextState) => {
      if (nextState === 'active') {
        // If model should be loaded but somehow isn't (e.g. native context was
        // invalidated by the OS), reload it.
        if (
          onDeviceRef.current &&
          modelStateRef.current !== 'ready' &&
          modelStateRef.current !== 'loading'
        ) {
          const downloaded = await isModelDownloaded().catch(() => false);
          if (downloaded) {
            setModelState('loading');
            initBaseModel()
              .then(() => setModelState('ready'))
              .catch((err) => setModelError(String(err)));
          }
        }
      }
    });

    return () => subscription.remove();
  }, [isAppInitialized]); // eslint-disable-line react-hooks/exhaustive-deps

  // Effect 3: Start/stop the inference queue.
  // Local mode: queue runs when model is ready (needs llama.rn).
  // Cloud mode: queue runs immediately (uses HTTP, no model needed).
  useEffect(() => {
    if (!isAppInitialized) return;

    const shouldRun = isOnDevice
      ? modelState === 'ready' // local: need model loaded
      : true; // cloud: always ready

    if (shouldRun) {
      inferenceQueue.start();
    } else if (inferenceQueue.getState() !== 'stopped') {
      inferenceQueue.stop();
    }
  }, [isAppInitialized, isOnDevice, modelState]);
}
