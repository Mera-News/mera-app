/**
 * The GraphQL field list every fact-check selection uses, and nothing else.
 *
 * A LEAF MODULE ON PURPOSE — no imports at all. Both selections in
 * `fact-check-graphql-client.ts` (`factCheck`, the ask, and `cachedFactCheck`,
 * the asked re-read) render through one panel, so they share one field list.
 * `articleById` no longer selects a check: a check is shown only to the device
 * that asked for it (navx).
 *
 * `checkedByStatus` is the field that must never be dropped silently — an empty
 * `checkedBy` means "nobody has published" or "we could not look", and those
 * two must never render the same. See `fact-check-types.ts`.
 */
export const FACT_CHECK_FIELDS = `
    _id
    status
    verdict
    summary
    checkedBy {
      organisation
      url
      verdict
      summary
    }
    checkedByStatus
    citations {
      title
      uri
      snippet
    }
    claims {
      claim
      assessment
      note
    }
    completedAt
    createdAt
    articleTitle
    articleUrl
    publicationName
    model
    attempts
`;
