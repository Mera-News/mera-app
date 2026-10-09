// buildOverlayContext is the one context every ••• sheet tree level gates and resolves against,
// the Feed card and the detail screen included. It must carry the article's own tags (entity,
// place) or the v5 tag leaves ("Show less of {{entity}}", "Less from this place") vanish
// silently. The suggestion row and the visits are seeded through the services.
import buildOverlayContext from '@/components/custom/cards/overlay-context';
import { recordPublicationVisit } from '@/lib/database/services/publication-visit-service';
import { seedSuggestion } from '../detail/seed';

const subject = {
    origin: 'suggestion' as const,
    surface: 'for_you' as const,
    articleId: 'a1',
    suggestionId: 'a1',
    title: 'T',
    publicationName: 'NOS',
    entities: ['From subject'],
};

describe('buildOverlayContext tags', () => {
    it('takes the primary entity and the place filter value from the local row first', async () => {
        await seedSuggestion({
            _id: 'a1',
            category: 'Politics',
            maxClusterSize: 4,
            geo_tags: [{ countryCode: 'NL' }],
            entities: [' ', 'Rutte', 'NATO'],
        } as never);
        const ctx = await buildOverlayContext(subject);
        expect(ctx).toMatchObject({ entity: 'Rutte', placeValue: 'NL', geoText: 'NL', clusterSize: 4, category: 'Politics' });
    });

    it('keeps the display text and the filter value distinct for a supranational place', async () => {
        await seedSuggestion({ _id: 'a1', geo_tags: [{ countryCode: 'MIDDLE_EAST' }] } as never);
        const ctx = await buildOverlayContext(subject);
        expect(ctx).toMatchObject({ geoText: 'Middle East', placeValue: 'MIDDLE_EAST' });
    });

    it('falls back to the subject entity, then the host fallback', async () => {
        // No suggestion row for this subject.
        const ctx = await buildOverlayContext(subject, { placeValue: 'EU', geoText: 'Europe', category: 'World' });
        expect(ctx).toMatchObject({ entity: 'From subject', placeValue: 'EU', geoText: 'Europe', category: 'World' });
        const bare = await buildOverlayContext({ ...subject, entities: [] }, { entity: 'Fallback' });
        expect(bare.entity).toBe('Fallback');
    });

    it('counts the reader’s recent visits to the publication', async () => {
        for (const id of ['v1', 'v2', 'v3']) {
            await recordPublicationVisit({ publicationName: 'NOS', countryCode: null, articleId: id });
        }
        await recordPublicationVisit({ publicationName: 'Other', countryCode: null, articleId: 'v4' });
        const ctx = await buildOverlayContext(subject);
        expect(ctx.publicationVisits).toBe(3);
    });
});
