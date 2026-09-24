// buildOverlayContext is the one context every ••• sheet tree level gates and
// resolves against, the Feed card and the detail screen included. It must
// carry the article's own tags (entity, place) or the v5 tag leaves
// ("Show less of {{entity}}", "Less from this place") vanish silently.
const mockRow = jest.fn();
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
    getSuggestionFeedbackContext: (...a: any[]) => mockRow(...a),
}));
jest.mock('@/lib/database/services/publication-visit-service', () => ({
    getVisitCountForPublication: jest.fn(async () => 3),
}));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));

import { buildOverlayContext } from '../overlay-context';

const subject = {
    origin: 'suggestion' as const,
    surface: 'for_you' as const,
    articleId: 'a1',
    suggestionId: 's1',
    title: 'T',
    publicationName: 'NOS',
    entities: ['From subject'],
};

beforeEach(() => mockRow.mockReset());

describe('buildOverlayContext tags', () => {
    it('takes the primary entity and the place filter value from the local row first', async () => {
        mockRow.mockResolvedValue({
            category: 'Politics',
            clusterSize: 4,
            geoText: 'Netherlands',
            placeValue: 'NL',
            entities: [' ', 'Rutte', 'NATO'],
        });
        const ctx = await buildOverlayContext(subject);
        expect(ctx).toMatchObject({ entity: 'Rutte', placeValue: 'NL', geoText: 'Netherlands', clusterSize: 4 });
    });

    it('falls back to the subject entity, then the host fallback', async () => {
        mockRow.mockResolvedValue(null);
        const ctx = await buildOverlayContext(subject, { placeValue: 'EU', geoText: 'Europe', category: 'World' });
        expect(ctx).toMatchObject({ entity: 'From subject', placeValue: 'EU', geoText: 'Europe', category: 'World' });
        const bare = await buildOverlayContext({ ...subject, entities: [] }, { entity: 'Fallback' });
        expect(bare.entity).toBe('Fallback');
    });
});
