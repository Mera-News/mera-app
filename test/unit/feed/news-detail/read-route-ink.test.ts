import { publisherRouteInk } from '@/components/custom/news-detail/read-route-ink';

describe('publisherRouteInk', () => {
    it('is green when this phone can translate the article', () => {
        expect(publisherRouteInk('translatable')).toBe('positive');
    });

    it('is the neutral ink when it cannot', () => {
        expect(publisherRouteInk('not-translatable')).toBe('ink');
    });

    it('is green for an article in the reader’s own language', () => {
        expect(publisherRouteInk('same-language')).toBe('positive');
    });

    it('keeps the ink outline when the language is unknown: readable is not proven', () => {
        expect(publisherRouteInk('unknown')).toBe('ink');
    });
});
