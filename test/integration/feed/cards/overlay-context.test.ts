// buildOverlayContext is the one context every ••• sheet tree level gates and resolves against,
// the Feed card and the detail screen included. It must carry the article's own tags (entity,
// place) or the v5 tag leaves ("Show less of {{entity}}", "Less from this place") vanish
// silently. The suggestion row and the visits are seeded through the services.
import buildOverlayContext from '@/components/custom/cards/overlay-context';
import { feedbackSubjectFromSuggestion } from '@/components/custom/cards/feedback-subject';
import { persistAndLinkV2Suggestions } from '@/lib/database/services/article-suggestion-persist';
import { loadSuggestions } from '@/lib/database/services/article-suggestion-reads';
import { addFact } from '@/lib/database/services/fact-service';
import { recordPublicationVisit } from '@/lib/database/services/publication-visit-service';
import { createTopics } from '@/lib/database/services/topic-service';
import type { ArticleWithClusters } from '@/lib/generated/graphql-types';
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

// The v6 sheet quotes the reader's fact. Topic ids and topic texts are different strings in
// real data (a topic id looks like "ERrc8wlp0GvqGovu"; a fact's metadata.topics holds texts),
// so a fixture where they match proves nothing.
describe('buildOverlayContext fact', () => {
    async function seedLinked() {
        const fact = await addFact('Pensioner in India; Lives in Bhopal', { topics: ['pensions India', 'Bhopal news'] });
        const other = await addFact('Follows cricket', { topics: ['cricket'] });
        const [topic] = await createTopics([{ text: 'Bhopal news', factId: fact.id, weight: 0.5 }]);
        expect(topic.id).not.toBe('Bhopal news');
        const row = {
            _id: 'bhopal-1',
            title: 'Bhopal water cuts',
            title_en: 'Bhopal water cuts',
            publication_name: 'Dainik Bhaskar',
            country_code: 'IND',
            language_code: 'hi',
            pubDate: '2026-08-01T00:00:00.000Z',
            clusters: [],
        } as unknown as ArticleWithClusters;
        await persistAndLinkV2Suggestions([row], new Map(), {
            matchedTopics: new Map([['bhopal-1', [{ topicId: topic.id, text: 'Bhopal news' }]]]),
        });
        const suggestion = (await loadSuggestions()).find((s) => s._id === 'bhopal-1')!;
        return { fact, other, topic, suggestion };
    }

    it('finds the fact the story is linked to, by the link, not by comparing a topic id to a text', async () => {
        const { fact, topic, suggestion } = await seedLinked();
        const ctx = await buildOverlayContext(feedbackSubjectFromSuggestion(suggestion, 'for_you'));
        expect(ctx.fact).toEqual({ id: fact.id, statement: 'Pensioner in India', topicTexts: ['pensions India', 'Bhopal news'] });
        // "Less for this" may move only that fact's matched topics, by id.
        expect(ctx.matchedTopics).toEqual([{ topicId: topic.id, text: 'Bhopal news' }]);
    });

    it('with no local row, falls back to the matched topic texts', async () => {
        const fact = await addFact('Follows Formula 1', { topics: ['Formula 1'] });
        const ctx = await buildOverlayContext({
            ...subject,
            articleId: 'no-row',
            suggestionId: undefined,
            matchedTopics: [{ topicId: 'Zx81kQ0aT7', text: 'Formula 1' }],
        });
        expect(ctx.fact?.id).toBe(fact.id);
    });

    it('a story that matched no fact has none (a headline-scope story)', async () => {
        const ctx = await buildOverlayContext({ ...subject, matchedTopics: [{ topicId: null, text: 'Top headlines' }] });
        expect(ctx.fact).toBeNull();
    });
});
