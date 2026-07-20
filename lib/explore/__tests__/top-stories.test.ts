// top-stories blend unit tests. blendTopStories is pure — no DB/RN mocking
// needed for it. getPersonaStableIds is the one impure helper (WatermelonDB
// read), covered via makeDatabaseMock like the other database/services tests.

jest.mock('@/lib/database/index', () => {
    const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
    return makeDatabaseMock();
});

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import { blendTopStories, getPersonaStableIds, type BlendInput } from '../top-stories';
import type { NewsArticle } from '@/lib/generated/graphql-types';

const db = database as any;

function article(id: string): NewsArticle {
    return { _id: id } as NewsArticle;
}

function input(over: Partial<BlendInput> & Pick<BlendInput, 'article' | 'source'>): BlendInput {
    return {
        stableClusterId: null,
        clusterSize: 0,
        editionRank: 0,
        ...over,
    };
}

describe('blendTopStories', () => {
    it('returns an empty list for empty inputs', () => {
        expect(blendTopStories([], [], new Set())).toEqual([]);
    });

    it('dedupes a shared stableClusterId across editions, home winning', () => {
        const globalEntry = input({
            article: article('global-article'),
            source: 'global',
            stableClusterId: 'story-1',
            clusterSize: 10,
            editionRank: 0,
        });
        const homeEntry = input({
            article: article('home-article'),
            source: 'home',
            stableClusterId: 'story-1',
            clusterSize: 10,
            editionRank: 0,
        });
        const result = blendTopStories([globalEntry], [homeEntry], new Set());
        expect(result).toHaveLength(1);
        expect(result[0].article._id).toBe('home-article');
        expect(result[0].source).toBe('home');
    });

    it('dedupes null-stableClusterId singletons by article id, home winning', () => {
        const globalEntry = input({ article: article('shared-id'), source: 'global', editionRank: 0 });
        const homeEntry = input({ article: article('shared-id'), source: 'home', editionRank: 0 });
        const result = blendTopStories([globalEntry], [homeEntry], new Set());
        expect(result).toHaveLength(1);
        expect(result[0].source).toBe('home');
    });

    it('does not dedupe distinct singletons even with the same null stableClusterId', () => {
        const a = input({ article: article('a'), source: 'global', editionRank: 0 });
        const b = input({ article: article('b'), source: 'home', editionRank: 0 });
        const result = blendTopStories([a], [b], new Set());
        expect(result).toHaveLength(2);
    });

    it('boosts and reorders a story that matches a persona stable id', () => {
        const bigger = input({
            article: article('bigger'),
            source: 'global',
            stableClusterId: 'bigger-story',
            clusterSize: 20,
            editionRank: 5,
        });
        const personaMatch = input({
            article: article('persona'),
            source: 'global',
            stableClusterId: 'persona-story',
            clusterSize: 15,
            editionRank: 6,
        });
        // Without the persona boost, `bigger` narrowly outranks `personaMatch`
        // (higher popularity, slightly better rank prior).
        const withoutBoost = blendTopStories([bigger, personaMatch], [], new Set());
        expect(withoutBoost.map((h) => h.article._id)).toEqual(['bigger', 'persona']);

        // The 0.35 persona boost flips the ordering.
        const withBoost = blendTopStories([bigger, personaMatch], [], new Set(['persona-story']));
        expect(withBoost.map((h) => h.article._id)).toEqual(['persona', 'bigger']);
    });

    it('sorts by score descending using clusterSize + editionRank', () => {
        const strong = input({
            article: article('strong'),
            source: 'global',
            clusterSize: 50,
            editionRank: 0,
        });
        const weak = input({
            article: article('weak'),
            source: 'global',
            clusterSize: 1,
            editionRank: 20,
        });
        const result = blendTopStories([strong, weak], [], new Set());
        expect(result.map((h) => h.article._id)).toEqual(['strong', 'weak']);
    });

    it('never leaves more than 3 consecutive items from the same source', () => {
        // 5 global (higher score via clusterSize) then 5 home (lower score) —
        // without the guard, sorting would put all 5 global items first.
        const globalEntries = Array.from({ length: 5 }, (_, i) =>
            input({
                article: article(`g${i}`),
                source: 'global' as const,
                clusterSize: 100 - i,
                editionRank: i,
            }),
        );
        const homeEntries = Array.from({ length: 5 }, (_, i) =>
            input({
                article: article(`h${i}`),
                source: 'home' as const,
                clusterSize: 10 - i,
                editionRank: i,
            }),
        );
        const result = blendTopStories(globalEntries, homeEntries, new Set());
        expect(result).toHaveLength(10);

        let run = 1;
        for (let i = 1; i < result.length; i++) {
            run = result[i].source === result[i - 1].source ? run + 1 : 1;
            expect(run).toBeLessThanOrEqual(3);
        }
    });
});

describe('getPersonaStableIds', () => {
    beforeEach(() => {
        db._setRows?.('article_suggestions', []);
    });

    it('returns the distinct non-null stable_cluster_id values', async () => {
        db._setRows('article_suggestions', [
            makeRecord({ id: 's1', stableClusterId: 'c1' }),
            makeRecord({ id: 's2', stableClusterId: 'c2' }),
            makeRecord({ id: 's3', stableClusterId: 'c1' }),
            makeRecord({ id: 's4', stableClusterId: null }),
        ]);
        const ids = await getPersonaStableIds();
        expect(ids).toEqual(new Set(['c1', 'c2']));
    });

    it('returns an empty set when there are no suggestions', async () => {
        db._setRows('article_suggestions', []);
        const ids = await getPersonaStableIds();
        expect(ids).toEqual(new Set());
    });
});
