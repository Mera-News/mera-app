import { languageHeadingOrder } from '../language-heading-order';

const codes = ['en', 'ar', 'nl', 'fr'];

describe('languageHeadingOrder', () => {
    it("starts with the phone's language, then every other once", () => {
        expect(languageHeadingOrder('nl', codes)).toEqual(['nl', 'en', 'ar', 'fr']);
    });
    it('falls back to English first for a language the app lacks', () => {
        expect(languageHeadingOrder('sw', codes)).toEqual(['en', 'ar', 'nl', 'fr']);
    });
});
