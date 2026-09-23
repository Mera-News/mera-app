// A user cancel must settle as a clean `not_downloaded`, never as a failure.
// RNFS rejects the in-flight download a moment AFTER the cancel, and that late
// rejection used to overwrite the state with an error plus a "Download Failed"
// notification.

let rejectDownload: (e: Error) => void = () => {};
let resolveDownload: () => void = () => {};
const mockDownloadBaseModel = jest.fn(
  () =>
    new Promise<void>((resolve, reject) => {
      resolveDownload = resolve;
      rejectDownload = reject;
    }),
);
jest.mock('../modelManager', () => ({
  downloadBaseModel: (...a: unknown[]) => (mockDownloadBaseModel as any)(...a),
  cancelActiveDownload: jest.fn(),
}));
const mockSchedule = jest.fn();
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  scheduleNotificationAsync: (...a: unknown[]) => mockSchedule(...a),
}));
jest.mock('i18next', () => ({ t: (k: string) => k }));
// Real hold bookkeeping (pure module state), so the test sees what a restart would.
jest.mock('react-native', () => ({ AppState: { currentState: 'active' } }));
jest.mock('../../../app-restart', () => {
  const holds = new Map<number, string>();
  let next = 1;
  return {
    holdRestart: (label: string) => {
      const id = next++;
      holds.set(id, label);
      return () => { holds.delete(id); };
    },
    activeHolds: () => Array.from(holds.values()),
  };
});
const mockCapture = jest.fn();
jest.mock('../../../logger', () => ({
  __esModule: true,
  default: { captureException: (...a: unknown[]) => mockCapture(...a), info: jest.fn() },
}));
const mockState = {
  modelState: 'not_downloaded',
  setModelState: jest.fn((s: string) => { mockState.modelState = s; }),
  setDownloadProgress: jest.fn(),
  setModelError: jest.fn(() => { mockState.modelState = 'error'; }),
};
jest.mock('../../../stores/mera-protocol-store', () => ({
  useMeraProtocolStore: { getState: () => mockState },
}));

import { cancelModelDownload, isDownloadInProgress, startModelDownload } from '../downloadService';
import { activeHolds } from '../../../app-restart';

const flush = () => new Promise((r) => setImmediate(r));
const cfg = { modelId: 'm', modelUrl: 'u', expectedChecksum: '' };

beforeEach(() => {
  jest.clearAllMocks();
  mockState.modelState = 'not_downloaded';
});

describe('downloadService restart hold (MERA-APP-7M)', () => {
  it('holds the app restart for the whole download and releases it on success', async () => {
    startModelDownload(cfg);
    await flush();
    expect(activeHolds()).toEqual(['model-download']);
    resolveDownload();
    await flush();
    expect(activeHolds()).toEqual([]);
  });

  it('releases the hold on failure', async () => {
    startModelDownload(cfg);
    await flush();
    rejectDownload(new Error('network down'));
    await flush();
    expect(activeHolds()).toEqual([]);
  });

  it('releases the hold on cancel, and a restarted download holds exactly once', async () => {
    startModelDownload(cfg);
    await flush();
    const rejectFirst = rejectDownload;
    await cancelModelDownload();
    expect(activeHolds()).toEqual([]);
    startModelDownload(cfg);
    await flush();
    rejectFirst(new Error('Download has been aborted'));
    await flush();
    expect(activeHolds()).toEqual(['model-download']);
    resolveDownload();
    await flush();
    expect(activeHolds()).toEqual([]);
  });
});

describe('downloadService cancel', () => {
  it('a cancel settles as not_downloaded with no error and no notification', async () => {
    startModelDownload(cfg);
    await flush();
    await cancelModelDownload();
    rejectDownload(new Error('Download has been aborted'));
    await flush();

    expect(mockState.modelState).toBe('not_downloaded');
    expect(mockState.setModelError).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('a real failure (no cancel) is still reported', async () => {
    startModelDownload(cfg);
    await flush();
    rejectDownload(new Error('network down'));
    await flush();

    expect(mockState.setModelError).toHaveBeenCalledWith('network down');
    expect(mockCapture).toHaveBeenCalled();
    expect(mockSchedule).toHaveBeenCalled();
  });

  it("an old download settling late cannot clear a new download's handle", async () => {
    startModelDownload(cfg);
    await flush();
    const rejectFirst = rejectDownload;
    await cancelModelDownload();
    startModelDownload(cfg); // second download, now the current one
    await flush();
    rejectFirst(new Error('Download has been aborted'));
    await flush();

    expect(isDownloadInProgress()).toBe(true);
    expect(mockState.modelState).toBe('downloading');
    resolveDownload();
    await flush();
    expect(mockState.modelState).toBe('downloaded');
  });
});
