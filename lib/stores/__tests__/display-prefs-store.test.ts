// Lite mode in the display-prefs store: the device default, the reader's
// override (AsyncStorage, device-level), and the one-time carry-over of the
// old "Static background" row.

const mockGetSetting = jest.fn((_key: string): Promise<string | null> => Promise.resolve(null));
const mockDeleteSetting = jest.fn((_key: string) => Promise.resolve());

jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: (key: string) => mockGetSetting(key),
    setSetting: jest.fn(() => Promise.resolve()),
    deleteSetting: (key: string) => mockDeleteSetting(key),
}));

// Mutable so each case can pose as a different device. `null` is expo-device's
// "couldn't determine" and must NOT be read as a weak phone.
let mockTotalMemory: number | null = null;
jest.mock('expo-device', () => ({
    get totalMemory() {
        return mockTotalMemory;
    },
}));

const mockCaptureException = jest.fn();
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: (...args: unknown[]) => mockCaptureException(...args),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { PERFORMANCE_OVERRIDE_KEY } from '@/lib/performance/performance-mode';
import { useDisplayPrefsStore } from '../display-prefs-store';

const GB = 1024 * 1024 * 1024;
const storage = AsyncStorage as unknown as { getItem: jest.Mock; setItem: jest.Mock };

describe('useDisplayPrefsStore (Lite mode)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockTotalMemory = null;
        storage.getItem.mockResolvedValue(null);
        storage.setItem.mockResolvedValue(undefined);
        useDisplayPrefsStore.setState({
            liteMode: false,
            deviceMode: 'full',
            performanceOverride: 'auto',
            hydrated: false,
        });
    });

    describe('device default when the reader never chose', () => {
        it('runs Lite on a 4 GB phone', async () => {
            mockTotalMemory = 4 * GB;
            await useDisplayPrefsStore.getState().hydrate();
            const s = useDisplayPrefsStore.getState();
            expect(s.deviceMode).toBe('lite');
            expect(s.liteMode).toBe(true);
            expect(s.hydrated).toBe(true);
        });

        it('treats exactly 6 GB as Full', async () => {
            mockTotalMemory = 6 * GB;
            await useDisplayPrefsStore.getState().hydrate();
            expect(useDisplayPrefsStore.getState().liteMode).toBe(false);
        });

        it('keeps Full when memory is unknown', async () => {
            mockTotalMemory = null;
            await useDisplayPrefsStore.getState().hydrate();
            expect(useDisplayPrefsStore.getState().liteMode).toBe(false);
        });
    });

    describe('the reader override wins over the device', () => {
        it('an explicit "full" keeps a 4 GB phone animated', async () => {
            mockTotalMemory = 4 * GB;
            storage.getItem.mockResolvedValue('full');
            await useDisplayPrefsStore.getState().hydrate();
            expect(useDisplayPrefsStore.getState().liteMode).toBe(false);
            expect(useDisplayPrefsStore.getState().performanceOverride).toBe('full');
        });

        it('an explicit "lite" applies on an 8 GB phone', async () => {
            mockTotalMemory = 8 * GB;
            storage.getItem.mockResolvedValue('lite');
            await useDisplayPrefsStore.getState().hydrate();
            expect(useDisplayPrefsStore.getState().liteMode).toBe(true);
        });

        it('does not touch the legacy row once an override exists', async () => {
            storage.getItem.mockResolvedValue('auto');
            await useDisplayPrefsStore.getState().hydrate();
            expect(mockGetSetting).not.toHaveBeenCalled();
        });
    });

    describe('carrying the old "Static background" choice over', () => {
        it('maps "1" to Lite, stores it, and deletes the old row', async () => {
            mockTotalMemory = 8 * GB;
            mockGetSetting.mockResolvedValueOnce('1');
            await useDisplayPrefsStore.getState().hydrate();
            expect(mockGetSetting).toHaveBeenCalledWith('static_gradient');
            expect(storage.setItem).toHaveBeenCalledWith(PERFORMANCE_OVERRIDE_KEY, 'lite');
            expect(mockDeleteSetting).toHaveBeenCalledWith('static_gradient');
            expect(useDisplayPrefsStore.getState().liteMode).toBe(true);
        });

        it('maps "0" to Full on a 4 GB phone', async () => {
            mockTotalMemory = 4 * GB;
            mockGetSetting.mockResolvedValueOnce('0');
            await useDisplayPrefsStore.getState().hydrate();
            expect(storage.setItem).toHaveBeenCalledWith(PERFORMANCE_OVERRIDE_KEY, 'full');
            expect(useDisplayPrefsStore.getState().liteMode).toBe(false);
        });

        it('no old row means auto, and nothing is deleted', async () => {
            await useDisplayPrefsStore.getState().hydrate();
            expect(storage.setItem).toHaveBeenCalledWith(PERFORMANCE_OVERRIDE_KEY, 'auto');
            expect(mockDeleteSetting).not.toHaveBeenCalled();
        });
    });

    it('still hydrates and reports when storage throws', async () => {
        mockTotalMemory = 4 * GB;
        storage.getItem.mockRejectedValueOnce(new Error('disk'));
        await expect(useDisplayPrefsStore.getState().hydrate()).resolves.toBeUndefined();
        const s = useDisplayPrefsStore.getState();
        expect(s.hydrated).toBe(true);
        expect(s.liteMode).toBe(true);
        expect(mockCaptureException).toHaveBeenCalled();
    });

    describe('setPerformanceOverride', () => {
        it('updates liteMode at once and persists the choice', () => {
            useDisplayPrefsStore.setState({ deviceMode: 'full' });
            useDisplayPrefsStore.getState().setPerformanceOverride('lite');
            expect(useDisplayPrefsStore.getState().liteMode).toBe(true);
            expect(storage.setItem).toHaveBeenCalledWith(PERFORMANCE_OVERRIDE_KEY, 'lite');
        });

        it('"auto" follows the device', () => {
            useDisplayPrefsStore.setState({ deviceMode: 'lite' });
            useDisplayPrefsStore.getState().setPerformanceOverride('auto');
            expect(useDisplayPrefsStore.getState().liteMode).toBe(true);
        });
    });
});
