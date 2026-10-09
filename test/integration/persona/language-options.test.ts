// Seam test for offeredLanguages: the real translation-service decides what this phone can
// translate into. The platform and OS major are the native edges (react-native Platform and
// expo-device), moved per case; the language list and the iOS version ladder are the real ones.
import { Platform } from 'react-native';
// Loaded here, not lazily by the setup's beforeEach: test/helpers/screen.ts registers RNTL hooks on first import.
import '@/test/helpers';
import { offeredLanguages } from '@/components/custom/auth/language-options';
import { __resetOSMajorCacheForTests } from '@/lib/translation-service';

// A getter, so translation-service reads whatever OS version the case set when it first asks.
let mockOsVersion: string | null = '18.0';
jest.mock('expo-device', () => ({
    isDevice: true,
    get osVersion() {
        return mockOsVersion;
    },
}));

const codes = (phone: string, current: string | null) => offeredLanguages(phone, current).map((l) => l.code);

const originalOS = Platform.OS;

function runOnIos(osVersion: string) {
    (Platform as { OS: string }).OS = 'ios';
    mockOsVersion = osVersion;
    __resetOSMajorCacheForTests();
}

afterEach(() => {
    (Platform as { OS: string }).OS = originalOS;
    mockOsVersion = '18.0';
    __resetOSMajorCacheForTests();
});

describe('offeredLanguages', () => {
    describe('on iOS 15, which cannot translate into Dutch, Thai or Hindi', () => {
        beforeEach(() => runOnIos('15.2'));

        it('offers English and what the phone can translate into, phone first, English second', () => {
            expect(codes('de', 'de')).toEqual([
                'de', 'en', 'ar', 'zh-Hans', 'zh-Hant', 'fr', 'it', 'ja', 'ko', 'pt', 'ru', 'es',
            ]);
            expect(codes('en', 'en')).toEqual([
                'en', 'ar', 'zh-Hans', 'zh-Hant', 'fr', 'de', 'it', 'ja', 'ko', 'pt', 'ru', 'es',
            ]);
        });

        it('always lists the language the app is in, even one the phone cannot translate into', () => {
            expect(codes('de', 'th')).toContain('th');
            expect(codes('de', 'de')).not.toContain('th');
            // First launch passes no current language: strictly filtered.
            expect(codes('de', null)).not.toContain('th');
            expect(codes('de', null)).toEqual(codes('de', 'de'));
        });
    });

    it('offers every supported language where the OS translates into all of them (iOS 18)', () => {
        runOnIos('18.0');

        const offered = codes('nl', 'nl');

        expect(offered).toHaveLength(20);
        expect(offered.slice(0, 2)).toEqual(['nl', 'en']);
    });

    it('offers every supported language on Android, where ML Kit downloads models on demand', () => {
        (Platform as { OS: string }).OS = 'android';

        const offered = codes('es', null);

        expect(offered).toHaveLength(20);
        expect(offered.slice(0, 2)).toEqual(['es', 'en']);
    });

    it('offers only English where the platform has no translator', () => {
        (Platform as { OS: string }).OS = 'web';

        expect(codes('de', null)).toEqual(['en']);
        expect(codes('de', 'de')).toEqual(['de', 'en']);
    });
});
