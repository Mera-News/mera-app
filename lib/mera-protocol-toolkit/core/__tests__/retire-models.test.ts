const mockDeleteBaseModel = jest.fn();
const mockIsModelDownloaded = jest.fn();
jest.mock('../modelManager', () => ({
  deleteBaseModel: (...a: unknown[]) => mockDeleteBaseModel(...a),
  isModelDownloaded: (...a: unknown[]) => mockIsModelDownloaded(...a),
}));
const mockUpdateProcessingMode = jest.fn();
jest.mock('@/lib/account-service', () => ({
  AccountService: { updateProcessingMode: (...a: unknown[]) => mockUpdateProcessingMode(...a) },
}));
const mockCapture = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: (...a: unknown[]) => mockCapture(...a), warn: jest.fn(), info: jest.fn() },
}));
const mockStore = {
  processingMode: 'ON_DEVICE',
  setProcessingMode: jest.fn(),
  setModelState: jest.fn(),
  setDownloadProgress: jest.fn(),
};
jest.mock('@/lib/stores/mera-protocol-store', () => ({
  useMeraProtocolStore: { getState: () => mockStore },
}));
let mockUserId: string | null = 'user-1';
jest.mock('@/lib/stores/user-store', () => ({
  useUserStore: { getState: () => ({ userId: mockUserId }) },
}));

import { retireLegacyModels } from '../retire-models';

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.processingMode = 'ON_DEVICE';
  mockUserId = 'user-1';
  mockDeleteBaseModel.mockResolvedValue(undefined);
  mockUpdateProcessingMode.mockResolvedValue({});
});

describe('retireLegacyModels', () => {
  it('deletes both retired model directories', async () => {
    mockIsModelDownloaded.mockResolvedValue(true);
    await retireLegacyModels();
    expect(mockDeleteBaseModel).toHaveBeenCalledWith('mera-qwen3.5-4b');
    expect(mockDeleteBaseModel).toHaveBeenCalledWith('mera-qwen3-4b');
  });

  it('keeps OnDevice when the selected catalogue model is on disk', async () => {
    mockIsModelDownloaded.mockResolvedValue(true);
    await retireLegacyModels();
    expect(mockStore.setProcessingMode).not.toHaveBeenCalled();
    expect(mockUpdateProcessingMode).not.toHaveBeenCalled();
  });

  it('moves an OnDevice user with no model on disk to Cloud, locally and on the server', async () => {
    mockIsModelDownloaded.mockResolvedValue(false);
    await retireLegacyModels();
    expect(mockStore.setProcessingMode).toHaveBeenCalledWith('CLOUD');
    expect(mockStore.setModelState).toHaveBeenCalledWith('not_downloaded');
    expect(mockUpdateProcessingMode).toHaveBeenCalledWith('user-1', 'CLOUD');
  });

  it('does nothing to the mode of a Cloud user', async () => {
    mockStore.processingMode = 'CLOUD';
    await retireLegacyModels();
    expect(mockIsModelDownloaded).not.toHaveBeenCalled();
    expect(mockStore.setProcessingMode).not.toHaveBeenCalled();
  });

  it('swallows a failed server write (boot must never fail on it)', async () => {
    mockIsModelDownloaded.mockResolvedValue(false);
    mockUpdateProcessingMode.mockRejectedValue(new Error('offline'));
    await expect(retireLegacyModels()).resolves.toBeUndefined();
    expect(mockStore.setProcessingMode).toHaveBeenCalledWith('CLOUD');
    expect(mockCapture).toHaveBeenCalled();
  });

  it('a failed delete is reported and does not stop the mode check', async () => {
    mockDeleteBaseModel.mockRejectedValueOnce(new Error('busy'));
    mockIsModelDownloaded.mockResolvedValue(false);
    await retireLegacyModels();
    expect(mockCapture).toHaveBeenCalled();
    expect(mockStore.setProcessingMode).toHaveBeenCalledWith('CLOUD');
  });

  it('skips the server write without a local identity', async () => {
    mockUserId = null;
    mockIsModelDownloaded.mockResolvedValue(false);
    await retireLegacyModels();
    expect(mockUpdateProcessingMode).not.toHaveBeenCalled();
    expect(mockStore.setProcessingMode).toHaveBeenCalledWith('CLOUD');
  });
});
