/**
 * GraphQL access for the article fact check.
 *
 * Two calls, both keyed on the article id:
 *   - `requestFactCheck` (mutation) — idempotent. An article another user has
 *     already checked comes back `complete` on this very call, which is why the
 *     hook treats the mutation's own return as the first poll result rather
 *     than always dropping into the polling loop.
 *   - `factCheck` (query) — NULLABLE and never throws server-side, and keeps
 *     answering after the article's 48h TTL has dropped the article row. It is
 *     therefore the safe call to make repeatedly.
 *
 * `no-cache` on both, matching every other live query in this app: a poll that
 * reads its own previous answer out of the Apollo cache never terminates.
 */

import { gql } from '@apollo/client';
import client from '../apollo-client';
import type { FactCheck } from '../generated/graphql-types';

// One selection set, used by both operations — the panel renders the same
// fields whichever call produced the row.
const FACT_CHECK_FIELDS = `
    _id
    status
    verdict
    summary
    claims {
      claim
      assessment
      note
    }
    citations {
      title
      uri
      snippet
    }
    articleUrl
    articleTitle
    publicationName
    model
    attempts
    completedAt
    createdAt
`;

const REQUEST_FACT_CHECK = gql`
  mutation RequestFactCheck($articleId: ID!) {
    requestFactCheck(articleId: $articleId) {
      ${FACT_CHECK_FIELDS}
    }
  }
`;

const GET_FACT_CHECK = gql`
  query GetFactCheck($articleId: ID!) {
    factCheck(articleId: $articleId) {
      ${FACT_CHECK_FIELDS}
    }
  }
`;

export const FactCheckService = {
    /**
     * Starts (or joins) the fact check for an article. Idempotent — a second
     * tap returns the existing row and costs nothing. Throws only when the
     * article row itself is gone, or on a transport failure; the caller turns
     * either into the panel's error state.
     */
    async requestFactCheck(articleId: string): Promise<FactCheck | null> {
        const { data } = await client.mutate<{ requestFactCheck: FactCheck }>({
            mutation: REQUEST_FACT_CHECK,
            variables: { articleId },
            fetchPolicy: 'no-cache',
        });
        return data?.requestFactCheck ?? null;
    },

    /**
     * Reads the cached fact check. Null means "nobody has asked for one yet" —
     * it is NOT an error, and this call is documented never to throw
     * server-side, so a null here during polling simply means "keep waiting".
     */
    async getFactCheck(articleId: string): Promise<FactCheck | null> {
        const { data } = await client.query<{ factCheck: FactCheck | null }>({
            query: GET_FACT_CHECK,
            variables: { articleId },
            fetchPolicy: 'no-cache',
        });
        return data?.factCheck ?? null;
    },
};
