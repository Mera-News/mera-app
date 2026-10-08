import { publisherRouteInk } from '../read-route-ink';

describe('publisherRouteInk', () => {
    it('is green when this phone can translate the article', () => {
        expect(publisherRouteInk('translatable')).toBe('positive');
    });

    it('is the neutral ink when it cannot', () => {
        expect(publisherRouteInk('not-translatable')).toBe('ink');
    });

    it('is the neutral ink for an article in the reader’s own language', () => {
        expect(publisherRouteInk('same-language')).toBe('ink');
    });
});
