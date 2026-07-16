// async-job-service unit tests — settings-backed last-nudge helpers (the
// single-slot pending-job lock + cycle-state marker were removed when the
// multi-batch scoring pipeline replaced the legacy async-job flow).

const mockGetSetting = jest.fn((..._args: any[]): Promise<string | null> => Promise.resolve(null));
const mockSetSetting = jest.fn((..._args: any[]): Promise<void> => Promise.resolve());
const mockDeleteSetting = jest.fn((..._args: any[]): Promise<void> => Promise.resolve());

jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
  setSetting: (...args: unknown[]) => mockSetSetting(...args),
  deleteSetting: (...args: unknown[]) => mockDeleteSetting(...args),
}));

import {
  getLastNudgeAt,
  setLastNudgeAt,
} from '../async-job-service';

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// getLastNudgeAt
// ---------------------------------------------------------------------------

describe('getLastNudgeAt', () => {
  it('returns null when no setting exists', async () => {
    mockGetSetting.mockResolvedValueOnce(null);
    const result = await getLastNudgeAt();
    expect(result).toBeNull();
  });

  it('returns the timestamp as a number', async () => {
    mockGetSetting.mockResolvedValueOnce('1700000000000');
    const result = await getLastNudgeAt();
    expect(result).toBe(1700000000000);
  });

  it('returns null for non-finite values', async () => {
    mockGetSetting.mockResolvedValueOnce('not-a-number');
    const result = await getLastNudgeAt();
    expect(result).toBeNull();
  });

  it('calls getSetting with the correct key', async () => {
    mockGetSetting.mockResolvedValueOnce(null);
    await getLastNudgeAt();
    expect(mockGetSetting).toHaveBeenCalledWith('async_inference_last_nudge');
  });
});

// ---------------------------------------------------------------------------
// setLastNudgeAt
// ---------------------------------------------------------------------------

describe('setLastNudgeAt', () => {
  it('calls setSetting with the timestamp as a string', async () => {
    await setLastNudgeAt(1700000000000);
    expect(mockSetSetting).toHaveBeenCalledWith(
      'async_inference_last_nudge',
      '1700000000000',
    );
  });
});
