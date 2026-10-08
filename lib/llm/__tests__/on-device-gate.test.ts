// The gate that keeps on-device mode off the cloud AI.

const mockStore = { processingMode: 'CLOUD' as string };
jest.mock('../../stores/mera-protocol-store', () => ({
  useMeraProtocolStore: { getState: () => mockStore },
}));
const mockGetSetting = jest.fn(async (_k: string): Promise<string | null> => null);
jest.mock('../../database/services/setting-service', () => ({
  getSetting: (k: string) => mockGetSetting(k),
}));

import {
  OnDeviceModeError,
  __resetOnDeviceGateForTests,
  assertCloudAllowed,
  isOnDeviceMode,
  isOnDeviceModeError,
} from '../on-device-gate';

beforeEach(() => {
  mockStore.processingMode = 'CLOUD';
  mockGetSetting.mockReset();
  mockGetSetting.mockResolvedValue(null);
  __resetOnDeviceGateForTests();
});

describe('isOnDeviceMode', () => {
  it('is false in cloud mode, and the setting is read once, not on every call', async () => {
    expect(await isOnDeviceMode()).toBe(false);
    expect(await isOnDeviceMode()).toBe(false);
    expect(mockGetSetting).toHaveBeenCalledTimes(1);
  });

  it('is true when the store says on-device, without reading the setting', async () => {
    mockStore.processingMode = 'ON_DEVICE';
    expect(await isOnDeviceMode()).toBe(true);
    expect(mockGetSetting).not.toHaveBeenCalled();
  });

  it('is true when the store is still on its Cloud default but the persisted mode is on-device (a background wake before hydration)', async () => {
    mockGetSetting.mockResolvedValue('ON_DEVICE');
    expect(await isOnDeviceMode()).toBe(true);
    // Never cached: the store may still be unhydrated on the next call.
    expect(await isOnDeviceMode()).toBe(true);
    expect(mockGetSetting).toHaveBeenCalledTimes(2);
  });

  it('follows a later switch to on-device through the store', async () => {
    expect(await isOnDeviceMode()).toBe(false);
    mockStore.processingMode = 'ON_DEVICE';
    expect(await isOnDeviceMode()).toBe(true);
  });

  it('falls back to the store when the setting cannot be read', async () => {
    mockGetSetting.mockRejectedValue(new Error('db'));
    expect(await isOnDeviceMode()).toBe(false);
  });
});

describe('assertCloudAllowed', () => {
  it('passes in cloud mode', async () => {
    await expect(assertCloudAllowed()).resolves.toBeUndefined();
  });

  it('throws a typed error in on-device mode', async () => {
    mockStore.processingMode = 'ON_DEVICE';
    const err = await assertCloudAllowed().catch((e) => e);
    expect(err).toBeInstanceOf(OnDeviceModeError);
    expect(isOnDeviceModeError(err)).toBe(true);
  });
});
