/**
 * GraphQL access for the article fact check.
 *
 * Two calls, both keyed on the article id:
 *   - `requestFactCheck` (mutation) — idempotent. An article another user has
 *     already checked comes back `complete` on this very call, which is why the
 *     hook renders the mutation's own return directly instead of waiting for a
 *     second round trip.
 *   - `factCheck` (query) — NULLABLE and never throws server-side, and keeps
 *     answering after the article's 48h TTL has dropped the article row. That
 *     durability is what lets a push notification, arriving long after the
 *     article is gone, still fetch its result.
 *
 * `no-cache` on both, matching every other live query in this app: the point of
 * re-reading is to find out whether the answer changed, which is precisely what
 * an Apollo cache hit would hide.
 */

import { gql } from '@apollo/client';
import client from '../apollo-client';
import type { FactCheck, FactCheckOrganisation } from '../generated/graphql-types';

/**
 * One organisation that published a fact check on this story.
 *
 * Now generated — this was hand-written while the server change was in flight,
 * and is re-exported under the old name so the panel's imports keep working.
 *
 * `verdict` is that organisation's OWN rating in its own words ("Mostly False",
 * "Altered photo", "Pants on Fire") and is deliberately NOT one of our closed
 * `FactCheck.verdict` values. Do not route it through `describeAssessment` — our
 * five-token vocabulary has no home for those strings, so every one of them
 * would render as "Unclear", silently deleting the attribution that is the whole
 * point of this list. Render unrecognised ratings verbatim.
 */
export type FactCheckedByEntry = FactCheckOrganisation;

/**
 * `checkedBy` is non-null on the server (`[FactCheckOrganisation!]!` — empty
 * list, never null), but stays optional here: a row cached on device before this
 * field existed, or fetched while `CHECKED_BY_SELECTION` is blanked below, has
 * no `checkedBy` at all.
 */
export type FactCheckRow = FactCheck & {
    checkedBy?: FactCheckedByEntry[] | null;
};

/**
 * RELEASE GATE — one line, deliberately.
 *
 * `checkedBy` does not exist on the deployed server's `FactCheck` type until
 * W1's change ships. GraphQL does not degrade on an unknown field: selecting it
 * fails VALIDATION, which would break `requestFactCheck` AND `factCheck`
 * outright — and this wave also turns fact-checking ON for every existing user,
 * so an OTA landing before the server deploy breaks the feature for everybody
 * rather than for nobody.
 *
 * Set to `''` to ship this app change ahead of the server. The panel already
 * renders an absent `checkedBy` as "no organisation has covered this yet", so
 * blanking it is a safe, one-line revert with no other code path to unwind.
 */
const CHECKED_BY_SELECTION = `
    checkedBy {
      organisation
      url
      verdict
      summary
    }
`;

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
    ${CHECKED_BY_SELECTION}
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
    async requestFactCheck(articleId: string): Promise<FactCheckRow | null> {
        const { data } = await client.mutate<{ requestFactCheck: FactCheckRow }>({
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
    async getFactCheck(articleId: string): Promise<FactCheckRow | null> {
        const { data } = await client.query<{ factCheck: FactCheckRow | null }>({
            query: GET_FACT_CHECK,
            variables: { articleId },
            fetchPolicy: 'no-cache',
        });
        return data?.factCheck ?? null;
    },
};
