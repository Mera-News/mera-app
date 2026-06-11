// inference-task.test.ts — unit tests for inference-task module

const mockDefineTask = jest.fn();
const mockRegisterTaskAsync = jest.fn();
const mockRunBackgroundCycle = jest.fn();
const mockCaptureException = jest.fn();

// Capture the registered task callback so we can invoke it
let capturedTaskCallback: ((body: any) => Promise<any>) | null = null;

jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn((name: string, fn: (body: any) => Promise<any>) => {
    mockDefineTask(name, fn);
    capturedTaskCallback = fn;
  }),
  isTaskRegisteredAsync: jest.fn(() => Promise.resolve(false)),
  unregisterTaskAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('expo-notifications', () => ({
  registerTaskAsync: (...args: any[]) => mockRegisterTaskAsync(...args),
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  getExpoPushTokenAsync: jest.fn(() => Promise.resolve({ data: 'ExponentPushToken[test]' })),
  setNotificationChannelAsync: jest.fn(() => Promise.resolve()),
  scheduleNotificationAsync: jest.fn(() => Promise.resolve('notif-id')),
  cancelAllScheduledNotificationsAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/lib/background/run-inference-handler', () => ({
  runBackgroundCycle: (...args: any[]) => mockRunBackgroundCycle(...args),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: (...args: any[]) => mockCaptureException(...args),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

// Suppress sentry-init and react-native-get-random-values side effects
jest.mock('@/lib/sentry-init', () => ({}));
jest.mock('react-native-get-random-values', () => ({}));

import {
  defineInferenceTask,
  ensureSilentPushTaskRegistered,
  INFERENCE_TASK,
} from '../inference-task';

beforeEach(() => {
  jest.clearAllMocks();
  capturedTaskCallback = null;
  mockRunBackgroundCycle.mockResolvedValue('no-work');
  mockRegisterTaskAsync.mockResolvedValue(undefined);
});

describe('INFERENCE_TASK constant', () => {
  it('exports a stable task name string', () => {
    expect(typeof INFERENCE_TASK).toBe('string');
    expect(INFERENCE_TASK.length).toBeGreaterThan(0);
  });
});

describe('defineInferenceTask', () => {
  it('calls TaskManager.defineTask with the INFERENCE_TASK name', () => {
    const TaskManager = require('expo-task-manager');
    defineInferenceTask();
    expect(TaskManager.defineTask).toHaveBeenCalledWith(
      INFERENCE_TASK,
      expect.any(Function),
    );
  });

  it('registers the task callback', () => {
    // The module-level `defined` flag may already be true from the previous
    // test ('calls TaskManager.defineTask'). Use isolateModules to get a fresh
    // module instance so defineInferenceTask() actually calls defineTask().
    jest.isolateModules(() => {
      jest.mock('expo-task-manager', () => ({
        defineTask: (name: string, fn: any) => {
          mockDefineTask(name, fn);
          capturedTaskCallback = fn;
        },
        isTaskRegisteredAsync: jest.fn(() => Promise.resolve(false)),
        unregisterTaskAsync: jest.fn(() => Promise.resolve()),
      }));
      jest.mock('@/lib/background/run-inference-handler', () => ({
        runBackgroundCycle: mockRunBackgroundCycle,
      }));
      jest.mock('@/lib/sentry-init', () => ({}));
      jest.mock('react-native-get-random-values', () => ({}));
      jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: mockCaptureException, warn: jest.fn(), info: jest.fn() } }));
      jest.mock('expo-notifications', () => ({ registerTaskAsync: mockRegisterTaskAsync }));
      const { defineInferenceTask: localDefine } = require('../inference-task');
      localDefine();
    });
    expect(capturedTaskCallback).not.toBeNull();
  });

  it('is idempotent — calling twice only defines once', () => {
    const TaskManager = require('expo-task-manager');
    // Reset defined flag by re-importing with isolateModules
    jest.isolateModules(() => {
      jest.mock('expo-task-manager', () => ({
        defineTask: mockDefineTask,
      }));
      jest.mock('@/lib/background/run-inference-handler', () => ({
        runBackgroundCycle: mockRunBackgroundCycle,
      }));
      jest.mock('@/lib/sentry-init', () => ({}));
      jest.mock('react-native-get-random-values', () => ({}));
      jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: mockCaptureException, warn: jest.fn(), info: jest.fn() } }));
      jest.mock('expo-notifications', () => ({ registerTaskAsync: mockRegisterTaskAsync }));
      const { defineInferenceTask: localDefine } = require('../inference-task');
      localDefine();
      localDefine(); // second call — should be no-op
      expect(mockDefineTask).toHaveBeenCalledTimes(1);
    });
  });
});

describe('task callback — extractPushData + reasonForPushType routing', () => {
  beforeEach(() => {
    // Ensure the task is defined and callback captured
    jest.isolateModules(() => {
      jest.mock('expo-task-manager', () => ({
        defineTask: (name: string, fn: any) => {
          mockDefineTask(name, fn);
          capturedTaskCallback = fn;
        },
      }));
      jest.mock('@/lib/background/run-inference-handler', () => ({
        runBackgroundCycle: mockRunBackgroundCycle,
      }));
      jest.mock('@/lib/sentry-init', () => ({}));
      jest.mock('react-native-get-random-values', () => ({}));
      jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: mockCaptureException, warn: jest.fn(), info: jest.fn() } }));
      jest.mock('expo-notifications', () => ({ registerTaskAsync: mockRegisterTaskAsync }));
      const { defineInferenceTask: localDefine } = require('../inference-task');
      localDefine();
    });
  });

  it('passes phase1-done reason when data.type = phase1-done', async () => {
    if (!capturedTaskCallback) return;
    const body = { data: { notification: { request: { content: { data: { type: 'phase1-done' } } } } } };
    await capturedTaskCallback(body);
    expect(mockRunBackgroundCycle).toHaveBeenCalledWith('phase1-done');
  });

  it('passes phase2-done reason when data.type = phase2-done', async () => {
    if (!capturedTaskCallback) return;
    const body = { data: { notification: { request: { content: { data: { type: 'phase2-done' } } } } } };
    await capturedTaskCallback(body);
    expect(mockRunBackgroundCycle).toHaveBeenCalledWith('phase2-done');
  });

  it('falls back to silent-push for inference-done type', async () => {
    if (!capturedTaskCallback) return;
    const body = { data: { notification: { request: { content: { data: { type: 'inference-done' } } } } } };
    await capturedTaskCallback(body);
    expect(mockRunBackgroundCycle).toHaveBeenCalledWith('silent-push');
  });

  it('falls back to silent-push for process-clusters type', async () => {
    if (!capturedTaskCallback) return;
    const body = { data: { notification: { request: { content: { data: { type: 'process-clusters' } } } } } };
    await capturedTaskCallback(body);
    expect(mockRunBackgroundCycle).toHaveBeenCalledWith('silent-push');
  });

  it('falls back to silent-push for unknown push type', async () => {
    if (!capturedTaskCallback) return;
    const body = { data: { notification: { request: { content: { data: { type: 'unknown-type' } } } } } };
    await capturedTaskCallback(body);
    expect(mockRunBackgroundCycle).toHaveBeenCalledWith('silent-push');
  });

  it('falls back to silent-push when body.data is missing', async () => {
    if (!capturedTaskCallback) return;
    await capturedTaskCallback({});
    expect(mockRunBackgroundCycle).toHaveBeenCalledWith('silent-push');
  });

  it('falls back to silent-push when notification structure is absent', async () => {
    if (!capturedTaskCallback) return;
    await capturedTaskCallback({ data: {} });
    expect(mockRunBackgroundCycle).toHaveBeenCalledWith('silent-push');
  });

  it('extracts type from body.data.data when notification path absent', async () => {
    if (!capturedTaskCallback) return;
    const body = { data: { data: { type: 'phase1-done' } } };
    await capturedTaskCallback(body);
    expect(mockRunBackgroundCycle).toHaveBeenCalledWith('phase1-done');
  });

  it('extracts type from body.data.dataString (JSON) when other paths absent', async () => {
    if (!capturedTaskCallback) return;
    const body = { data: { dataString: JSON.stringify({ type: 'phase2-done' }) } };
    await capturedTaskCallback(body);
    expect(mockRunBackgroundCycle).toHaveBeenCalledWith('phase2-done');
  });

  it('extracts type directly from body.data.type field', async () => {
    if (!capturedTaskCallback) return;
    const body = { data: { type: 'phase1-done' } };
    await capturedTaskCallback(body);
    expect(mockRunBackgroundCycle).toHaveBeenCalledWith('phase1-done');
  });

  it('catches exceptions from runBackgroundCycle and calls captureException', async () => {
    if (!capturedTaskCallback) return;
    const err = new Error('background cycle error');
    mockRunBackgroundCycle.mockRejectedValueOnce(err);
    const body = { data: {} };
    await capturedTaskCallback(body);
    expect(mockCaptureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ tags: { service: 'inference-task' } }),
    );
  });

  it('handles invalid JSON in dataString gracefully (falls back to silent-push)', async () => {
    if (!capturedTaskCallback) return;
    const body = { data: { dataString: 'not-valid-json' } };
    await capturedTaskCallback(body);
    // Should not throw; reason is silent-push due to no valid type extraction
    expect(mockRunBackgroundCycle).toHaveBeenCalledWith('silent-push');
  });
});

describe('ensureSilentPushTaskRegistered', () => {
  it('calls Notifications.registerTaskAsync with INFERENCE_TASK name', async () => {
    await ensureSilentPushTaskRegistered();
    expect(mockRegisterTaskAsync).toHaveBeenCalledWith(INFERENCE_TASK);
  });

  it('swallows exceptions from registerTaskAsync and calls captureException', async () => {
    const err = new Error('registration failed');
    mockRegisterTaskAsync.mockRejectedValueOnce(err);

    await expect(ensureSilentPushTaskRegistered()).resolves.toBeUndefined();
    expect(mockCaptureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: expect.objectContaining({ service: 'inference-task', step: 'register-push' }),
      }),
    );
  });
});

export {};
