// systemRequirements.ts checks Device capabilities, the built-in text model (D37) and storage.

import { Platform } from 'react-native';
import { checkRequirements } from '@/lib/mera-protocol-toolkit/core/systemRequirements';
import { installOnDeviceLlm } from '@/test/helpers/on-device-llm';

jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);
// jest.mock() is hoisted before variable declarations, so the factory must NOT
// directly reference variables defined below (they would be in the TDZ).
// We use a lazy wrapper so getFSInfo is looked up at call time, not factory time.
jest.mock('@dr.pogodin/react-native-fs', () => ({
  getFSInfo: (...args: any[]) => mockGetFSInfo(...args),
}));
jest.mock('expo-file-system/legacy', () => ({
  getFreeDiskStorageAsync: (...args: any[]) => mockGetFreeDiskStorage(...args),
}));

const mockGetFSInfo = jest.fn();
// The volume's capacity for important usage: what iOS will free for a download.
const mockGetFreeDiskStorage = jest.fn();

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

// systemRequirements.ts reads Platform.OS from react-native. The real Platform stays (the integration setup's
// database needs the rest of react-native); only its OS is driven per test.
const mockPlatformOS = { OS: 'ios' as string };
const realOS = Object.getOwnPropertyDescriptor(Platform, 'OS')!;

beforeAll(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => mockPlatformOS.OS });
});

afterAll(() => {
  Object.defineProperty(Platform, 'OS', realOS);
});

const GB = 1024 * 1024 * 1024;
const ENOUGH_STORAGE = 4 * GB;
const KEV_ONLY = 3_033_489_824; // the one model still to download

describe('checkRequirements', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPlatformOS.OS = 'ios';
    mockDevice.totalMemory = 8 * GB;
    mockDevice.osVersion = '17.0';
    mockDevice.modelId = 'iPhone15,2';
    mockDevice.platformApiLevel = null;
    mockGetFreeDiskStorage.mockResolvedValue(ENOUGH_STORAGE);
    mockGetFSInfo.mockResolvedValue({ freeSpace: ENOUGH_STORAGE });
    installOnDeviceLlm({ availability: { available: true, reason: null } });
  });

  describe('the built-in text model (Apple Intelligence, Gemini Nano)', () => {
    it('fails on Android during the iOS-only beta, even with Gemini Nano available', async () => {
      mockPlatformOS.OS = 'android';
      mockDevice.platformApiLevel = 34;
      const result = await checkRequirements();
      expect(result.supported).toBe(false);
      expect(result.failedCheck).toBe('built_in');
    });

    it.each([
      ['no built-in model on this phone', 'unsupportedPlatform' as const],
      ['a phone that is not eligible', 'deviceNotEligible' as const],
      ['an OS too old for it', 'osTooOld' as const],
    ])('fails on %s: this phone cannot run On this phone', async (_label, reason) => {
      installOnDeviceLlm({ availability: { available: false, reason } });
      const result = await checkRequirements();
      expect(result.supported).toBe(false);
      expect(result.failedCheck).toBe('built_in');
    });

    it.each([
      ['still downloading', 'modelNotReady' as const],
      ['switched off in Settings', 'appleIntelligenceNotEnabled' as const],
      ['the app language', 'appLanguageNotSupported' as const],
      ['a pending system update', 'needsSystemUpdate' as const],
    ])('passes when it is only %s: the screen shows the reason instead', async (_label, reason) => {
      installOnDeviceLlm({ availability: { available: false, reason } });
      expect((await checkRequirements()).supported).toBe(true);
    });

    it('a phone that fails RAM reports RAM first', async () => {
      installOnDeviceLlm({ availability: { available: false, reason: 'unsupportedPlatform' } });
      mockDevice.totalMemory = 2 * GB;
      expect((await checkRequirements()).failedCheck).toBe('ram');
    });
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
      mockGetFreeDiskStorage.mockResolvedValue(4 * GB);
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

  describe('storage check (only the bytes still to download count)', () => {
    it('fails when free storage is below what is missing plus the 0.5 GB margin, in decimal GB', async () => {
      mockGetFreeDiskStorage.mockResolvedValue(3_000_000_000);
      const result = await checkRequirements({ bytesToDownload: KEV_ONLY });
      expect(result.supported).toBe(false);
      expect(result.failedCheck).toBe('storage');
      expect(result.reason).toMatch(/3\.5 GB free storage/);
      expect(result.deviceInfo.freeStorageGB).toBe(3);
    });

    it('passes with exactly what is missing plus the margin', async () => {
      mockGetFreeDiskStorage.mockResolvedValue(KEV_ONLY + 500_000_000);
      const result = await checkRequirements({ bytesToDownload: KEV_ONLY });
      expect(result.failedCheck).not.toBe('storage');
    });

    it('never fails on storage once nothing is left to download, however full the phone is', async () => {
      mockGetFreeDiskStorage.mockResolvedValue(1_000);
      expect((await checkRequirements()).supported).toBe(true);
      expect((await checkRequirements({ bytesToDownload: 0 })).supported).toBe(true);
    });

    it('counts space iOS would free for a download, not only the plain free space (MERA-APP-93)', async () => {
      // NSFileSystemFreeSize leaves out purgeable space: a phone with hundreds of GB available read as full.
      mockGetFSInfo.mockResolvedValue({ freeSpace: 1_000_000_000 });
      mockGetFreeDiskStorage.mockResolvedValue(300_000_000_000);
      const result = await checkRequirements({ bytesToDownload: KEV_ONLY });
      expect(result.failedCheck).not.toBe('storage');
      expect(result.deviceInfo.freeStorageGB).toBe(300);
    });

    it('skips storage check when the free-space read throws', async () => {
      mockGetFreeDiskStorage.mockRejectedValue(new Error('FS unavailable'));
      const result = await checkRequirements({ bytesToDownload: KEV_ONLY });
      expect(result.deviceInfo.freeStorageGB).toBeNull();
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
