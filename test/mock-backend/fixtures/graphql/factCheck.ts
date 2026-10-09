import type { FactCheck } from '@/lib/generated/graphql-types';

/** One completed check. `checkedBy` is empty AND `checkedByStatus` is `searched`:
 *  "we looked and nobody has published", the normal case. */
export function factCheckFor(articleId: string, now: number): FactCheck {
    const at = new Date(now - 60_000).toISOString();
    return {
        __typename: 'FactCheck',
        _id: '66e2e0000000000000000020',
        status: 'complete',
        verdict: 'supported',
        summary: 'The article\'s main claims match the sources it cites.',
        checkedBy: [],
        checkedByStatus: 'searched',
        citations: [
            { __typename: 'FactCheckCitation', title: 'City council minutes', uri: 'https://example.com/minutes', snippet: 'Repairs approved for the spring.' },
        ],
        claims: [
            { __typename: 'FactCheckClaim', claim: 'Repairs run through spring.', assessment: 'supported', note: null },
        ],
        completedAt: at,
        createdAt: at,
        articleTitle: 'Harbour bridge repairs begin in Fixtureville',
        articleUrl: `https://example.com/story/${articleId}`,
        publicationName: 'Fixtureville Courier',
        model: 'fixture-model',
        attempts: 1,
    };
}

export const factCheck: FactCheck = factCheckFor('a00000000000000000000001', Date.now());
