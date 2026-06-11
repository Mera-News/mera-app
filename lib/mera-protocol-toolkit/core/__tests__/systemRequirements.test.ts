// systemRequirements.ts checks Device capabilities and storage.

// jest.mock() is hoisted before variable declarations, so the factory must NOT
// directly reference variables defined below (they would be in the TDZ).
// We use a lazy wrapper so getFSInfo is looked up at call time, not factory time.
jest.mock('@dr.pogodin/react-native-fs', () => ({
  getFSInfo: (...args: any[]) => mockGetFSInfo(...args),
}));

const mockGetFSInfo = jest.fn();

const mockDevice = {
  totalMemory: 8 * 1024 * 1024 * 1024, // 8 GB
  osVersion: '17.0',
  modelId: 'iPhone15,2', // iPhone 15 Pro — passes chip check
  platformApiLevel: null as number | null,
};

jest.mock('expo-device', () => ({
  get totalMemory() { return mockDevice.totalMemory; },
  get osVersion() { return mockDevice.osVersion; },
  get modelId() { return mockDevice.modelId; },
  get platformApiLevel() { return mockDevice.platformApiLevel; },
}));

// systemRequirements.ts imports Platform from 'react-native', not the deep path.
// We must mock 'react-native' (or its actual resolution) so the source gets the mock.
// The factory is self-contained: uses a module-scope var so Jest hoisting works.
const mockPlatformOS = { OS: 'ios' as string };

jest.mock('react-native', () => ({
  Platform: {
    get OS() { return mockPlatformOS.OS; },
    select: (obj: any) => obj[mockPlatformOS.OS],
  },
}));

import { checkRequirements } from '../systemRequirements';

const GB = 1024 * 1024 * 1024;
const ENOUGH_STORAGE = 4 * GB; // > 2.5 GB threshold
const LOW_STORAGE = 1 * GB;   // < 2.5 GB threshold

describe('checkRequirements', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPlatformOS.OS = 'ios';
    mockDevice.totalMemory = 8 * GB;
    mockDevice.osVersion = '17.0';
    mockDevice.modelId = 'iPhone15,2';
    mockDevice.platformApiLevel = null;
    mockGetFSInfo.mockResolvedValue({ freeSpace: ENOUGH_STORAGE });
  });

  describe('happy path — all checks pass', () => {
    it('returns supported=true when all requirements are met', async () => {
      const result = await checkRequirements();
      expect(result.supported).toBe(true);
      expect(result.failedCheck).toBeNull();
    });

    it('returns reason "All requirements met"', async () => {
      const result = await checkRequirements();
      expect(result.reason).toBe('All requirements met');
    });

    it('includes deviceInfo with ramGB', async () => {
      const result = await checkRequirements();
      expect(result.deviceInfo.ramGB).toBe(8); // 8 GB, rounded to 1 decimal
    });

    it('includes deviceInfo with osVersion', async () => {
      const result = await checkRequirements();
      expect(result.deviceInfo.osVersion).toBe('17.0');
    });

    it('includes deviceInfo with platform=ios', async () => {
      const result = await checkRequirements();
      expect(result.deviceInfo.platform).toBe('ios');
    });

    it('includes deviceInfo with modelId on iOS', async () => {
      const result = await checkRequirements();
      expect(result.deviceInfo.modelId).toBe('iPhone15,2');
    });

    it('includes deviceInfo with freeStorageGB', async () => {
      mockGetFSInfo.mockResolvedValue({ freeSpace: 4 * GB });
      const result = await checkRequirements();
      expect(result.deviceInfo.freeStorageGB).toBeCloseTo(4, 0);
    });
  });

  describe('RAM check', () => {
    it('fails when RAM is below 6 GB', async () => {
      mockDevice.totalMemory = 4 * GB;
      const result = await checkRequirements();
      expect(result.supported).toBe(false);
      expect(result.failedCheck).toBe('ram');
      expect(result.reason).toMatch(/Requires at least 6 GB RAM/);
    });

    it('passes when RAM is exactly 6 GB', async () => {
      mockDevice.totalMemory = 6 * GB;
      const result = await checkRequirements();
      expect(result.failedCheck).not.toBe('ram');
    });

    it('skips RAM check when totalMemory is null', async () => {
      mockDevice.totalMemory = null as any;
      const result = await checkRequirements();
      // RAM check skipped, other checks may pass
      expect(result.deviceInfo.ramGB).toBeNull();
    });
  });

  describe('OS version check — iOS', () => {
    it('fails when iOS version is below 16', async () => {
      mockDevice.osVersion = '15.7';
      const result = await checkRequirements();
      expect(result.supported).toBe(false);
      expect(result.failedCheck).toBe('os_version');
      expect(result.reason).toMatch(/iOS 16/);
    });

    it('passes when iOS version is exactly 16', async () => {
      mockDevice.osVersion = '16.0';
      const result = await checkRequirements();
      expect(result.failedCheck).not.toBe('os_version');
    });

    it('passes when iOS version is 17+', async () => {
      mockDevice.osVersion = '17.5';
      const result = await checkRequirements();
      expect(result.failedCheck).not.toBe('os_version');
    });

    it('skips iOS version check when osVersion is null', async () => {
      mockDevice.osVersion = null as any;
      const result = await checkRequirements();
      expect(result.failedCheck).not.toBe('os_version');
    });
  });

  describe('OS version check — Android', () => {
    beforeEach(() => {
      mockPlatformOS.OS = 'android';
      mockDevice.platformApiLevel = 30;
    });

    it('fails when Android API level is below 29', async () => {
      mockDevice.platformApiLevel = 28;
      const result = await checkRequirements();
      expect(result.supported).toBe(false);
      expect(result.failedCheck).toBe('os_version');
      expect(result.reason).toMatch(/Android 10/);
    });

    it('passes when Android API level is exactly 29', async () => {
      mockDevice.platformApiLevel = 29;
      const result = await checkRequirements();
      expect(result.failedCheck).not.toBe('os_version');
    });

    it('skips Android API check when platformApiLevel is null', async () => {
      mockDevice.platformApiLevel = null;
      const result = await checkRequirements();
      expect(result.failedCheck).not.toBe('os_version');
    });

    it('platform is "android" in deviceInfo', async () => {
      const result = await checkRequirements();
      expect(result.deviceInfo.platform).toBe('android');
    });
  });

  describe('chip check — iOS only', () => {
    it('fails for old iPhone (iPhone13,x = A15 but our min is iPhone14,x)', async () => {
      mockDevice.modelId = 'iPhone13,2'; // iPhone 13 Mini — A15 but ID < 14
      const result = await checkRequirements();
      expect(result.supported).toBe(false);
      expect(result.failedCheck).toBe('chip');
      expect(result.reason).toMatch(/A15 chip/);
    });

    it('passes for iPhone14,x (minimum supported)', async () => {
      mockDevice.modelId = 'iPhone14,2'; // iPhone 13 Pro
      const result = await checkRequirements();
      expect(result.failedCheck).not.toBe('chip');
    });

    it('passes for iPhone15,x', async () => {
      mockDevice.modelId = 'iPhone15,3';
      const result = await checkRequirements();
      expect(result.failedCheck).not.toBe('chip');
    });

    it('fails for old iPad (iPad12,x < iPad13,x threshold)', async () => {
      mockDevice.modelId = 'iPad12,1';
      const result = await checkRequirements();
      expect(result.supported).toBe(false);
      expect(result.failedCheck).toBe('chip');
      expect(result.reason).toMatch(/M1 chip/);
    });

    it('passes for iPad13,x (M1 iPad Pro)', async () => {
      mockDevice.modelId = 'iPad13,4';
      const result = await checkRequirements();
      expect(result.failedCheck).not.toBe('chip');
    });

    it('allows unknown modelId (null) to proceed', async () => {
      mockDevice.modelId = null as any;
      const result = await checkRequirements();
      expect(result.failedCheck).not.toBe('chip');
    });

    it('allows non-iPhone/iPad Apple devices to proceed', async () => {
      mockDevice.modelId = 'AppleTV6,2';
      const result = await checkRequirements();
      expect(result.failedCheck).not.toBe('chip');
    });

    it('skips chip check on Android', async () => {
      mockPlatformOS.OS = 'android';
      mockDevice.platformApiLevel = 30;
      // Android has no chip check — even a "bad" model ID should not fail chip
      const result = await checkRequirements();
      expect(result.failedCheck).not.toBe('chip');
    });
  });

  describe('storage check', () => {
    it('fails when free storage is below 2.5 GB', async () => {
      mockGetFSInfo.mockResolvedValue({ freeSpace: LOW_STORAGE }); // 1 GB
      const result = await checkRequirements();
      expect(result.supported).toBe(false);
      expect(result.failedCheck).toBe('storage');
      expect(result.reason).toMatch(/2\.5 GB free storage/);
    });

    it('passes when free storage is exactly 2.5 GB', async () => {
      mockGetFSInfo.mockResolvedValue({ freeSpace: 2.5 * GB });
      const result = await checkRequirements();
      expect(result.failedCheck).not.toBe('storage');
    });

    it('skips storage check when getFSInfo throws', async () => {
      mockGetFSInfo.mockRejectedValue(new Error('FS unavailable'));
      const result = await checkRequirements();
      expect(result.deviceInfo.freeStorageGB).toBeNull();
      // Should not fail on storage
      expect(result.failedCheck).not.toBe('storage');
    });
  });

  describe('unknown platform', () => {
    it('sets platform to "unknown" for unsupported platforms', async () => {
      mockPlatformOS.OS = 'web';
      const result = await checkRequirements();
      expect(result.deviceInfo.platform).toBe('unknown');
    });
  });

  describe('check ordering (short-circuit)', () => {
    it('returns ram failure before checking OS version', async () => {
      mockDevice.totalMemory = 2 * GB; // fails RAM
      mockDevice.osVersion = '15.0'; // would also fail OS
      const result = await checkRequirements();
      expect(result.failedCheck).toBe('ram');
    });
  });
});
