const mockGetLocales = jest.fn();

jest.mock('expo-localization', () => ({
    getLocales: () => mockGetLocales(),
}));

import { getDeviceCountryAlpha2 } from '../device-country';

describe('getDeviceCountryAlpha2', () => {
    afterEach(() => mockGetLocales.mockReset());

    it('returns the upper-cased device region code', () => {
        mockGetLocales.mockReturnValue([{ regionCode: 'in', languageTag: 'en-IN' }]);
        expect(getDeviceCountryAlpha2()).toBe('IN');
    });

    it('falls back to US when there is no region code', () => {
        mockGetLocales.mockReturnValue([{ regionCode: null, languageTag: 'en' }]);
        expect(getDeviceCountryAlpha2()).toBe('US');
    });

    it('falls back to US when getLocales is empty', () => {
        mockGetLocales.mockReturnValue([]);
        expect(getDeviceCountryAlpha2()).toBe('US');
    });
});
