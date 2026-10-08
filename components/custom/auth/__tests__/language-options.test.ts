jest.mock('@/lib/translation-service', () => ({
    SUPPORTED_LANGUAGES: [
        { code: 'en', name: 'English', native: 'English' },
        { code: 'de', name: 'German', native: 'Deutsch' },
        { code: 'nl', name: 'Dutch', native: 'Nederlands' },
        { code: 'th', name: 'Thai', native: 'ไทย' },
    ],
    canTranslateIntoLanguage: (code: string) => code === 'de' || code === 'nl',
}));

import { offeredLanguages } from '../language-options';

const codes = (phone: string, current: string | null) => offeredLanguages(phone, current).map((l) => l.code);

describe('offeredLanguages', () => {
    it('offers English and what the phone can translate into, phone first, English second', () => {
        expect(codes('nl', 'nl')).toEqual(['nl', 'en', 'de']);
        expect(codes('en', 'en')).toEqual(['en', 'de', 'nl']);
    });

    it('always lists the language the app is in, even one the phone cannot translate into', () => {
        expect(codes('nl', 'th')).toEqual(['nl', 'en', 'de', 'th']);
        expect(codes('nl', 'nl')).not.toContain('th');
        // First launch passes no current language: strictly filtered.
        expect(codes('nl', null)).toEqual(['nl', 'en', 'de']);
    });
});
