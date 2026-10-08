import { filterStories, isLeftOut, leftOutStories, storiesPerTopic } from '../fact-page-model';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function row(id: string, over: Partial<ForYouSuggestion>): ForYouSuggestion {
    return {
        _id: id,
        articleId: `a-${id}`,
        clusters: [],
        relevance: 0.1,
        reason: '',
        status: 'complete',
        factIds: ['f1'],
        firstPubDate: hoursAgo(1),
        title_en: `Unrelated headline ${id} ${'x'.repeat(Number(id.replace(/\D/g, '')) || 1)}`,
        eventType: null,
        matchedTopics: [],
        ...over,
    } as unknown as ForYouSuggestion;
}

describe('fact page model', () => {
    it('left out = below the bar, excluded or already read; never unscored', () => {
        expect(isLeftOut(row('1', { relevance: 0.1 }))).toBe(true);
        expect(isLeftOut(row('2', { relevance: 0.99 }))).toBe(false);
        expect(isLeftOut(row('3', { status: 'excluded', relevance: 0.99 } as never))).toBe(true);
        expect(isLeftOut(row('4', { status: 'already_read', relevance: 0.99 } as never))).toBe(true);
        expect(isLeftOut(row('5', { status: 'unscored' } as never))).toBe(false);
    });

    it('keeps only this fact, inside 48 hours, newest first', () => {
        const stories = leftOutStories(
            [
                row('1', { firstPubDate: hoursAgo(5), title_en: 'Bridge closes for repairs in the west' }),
                row('2', { firstPubDate: hoursAgo(1), title_en: 'Council votes on a new parking plan' }),
                row('3', { factIds: ['other'], title_en: 'Somewhere else entirely today' }),
                row('4', { firstPubDate: hoursAgo(60), title_en: 'An old story from three days ago' }),
            ],
            'f1',
            NOW,
        );
        expect(stories.map((s) => s.data._id)).toEqual(['2', '1']);
    });

    it('counts a story once per matched topic, by id or by text', () => {
        const count = storiesPerTopic([
            { data: row('1', { matchedTopics: [{ topicId: 't1', text: 'Power outages' }] }), members: [] },
            {
                data: row('2', { matchedTopics: [{ topicId: 't1', text: 'Power outages' }] }),
                members: [row('3', { matchedTopics: [{ topicId: null, text: 'Housing' }] })],
            },
        ]);
        expect(count({ id: 't1', text: 'Power outages' })).toBe(2);
        expect(count({ id: 't9', text: ' housing ' })).toBe(1);
        expect(count({ id: 't8', text: 'Nothing' })).toBe(0);
    });
});

describe('filterStories', () => {
    const picked = (id: string, ms: number) => ({ data: { _id: id }, pubDateMs: ms }) as never;
    const left = (id: string, iso: string) => ({ data: { _id: id, firstPubDate: iso }, members: [] }) as never;
    const P = [picked('p-new', Date.parse('2026-10-08T10:00:00Z')), picked('p-old', Date.parse('2026-10-07T10:00:00Z'))];
    const L = [left('l-mid', '2026-10-08T09:00:00Z')];
    const ids = (xs: ReturnType<typeof filterStories>) =>
        xs.map((x) => `${(x.story as unknown as { data: { _id: string } }).data._id}:${x.left}`);

    it('All merges both lists newest first, marking the left-out rows', () => {
        expect(ids(filterStories('all', P, L))).toEqual(['p-new:false', 'l-mid:true', 'p-old:false']);
    });
    it('Suggested is the Feed section only', () => {
        expect(ids(filterStories('suggested', P, L))).toEqual(['p-new:false', 'p-old:false']);
    });
    it('Discarded is the left-out list only', () => {
        expect(ids(filterStories('discarded', P, L))).toEqual(['l-mid:true']);
    });
    it('is empty when both lists are', () => {
        expect(filterStories('all', [], [])).toEqual([]);
    });
});
