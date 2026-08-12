/**
 * The GraphQL field list every fact-check selection uses, and nothing else.
 *
 * A LEAF MODULE ON PURPOSE — no imports at all. Two very different callers need
 * this string: `fact-check-graphql-client.ts` (the `factCheck(articleId)`
 * query, which drags in the WatermelonDB record service for its mirror write)
 * and `article-service.ts` (the `articleById` → `factCheck` selection). Exporting
 * it from the client would have pulled the whole local database layer into
 * `article-service.ts`, which is imported by nearly every list surface in the
 * app — a real cost for a string constant.
 *
 * ONE list, not two, because the panel renders one shape: a field added for the
 * poll path has to reach the article-attached path as well, or a check
 * mirrored from an article would render with less than one fetched by a poll.
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
