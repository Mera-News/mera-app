/**
 * The article fact-check payload shape — the stable import point for the
 * render layer (`FactCheckPanel`, `FactCheckSources`, `FactCheckCard`,
 * `fact-check-state.ts`) and for the GraphQL client.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS HAND-WRITTEN RATHER THAN CODEGEN'D.
 * Fact-checking is server-side again (pivot P8d) — the on-device runner from
 * the previous pivot (`fact-check-runner.ts`) now backs only the QUICK,
 * ephemeral chat path, which never persists and never touches this file. This
 * SHAPE instead mirrors the SERVER's `FactCheck` GraphQL type, but is declared
 * locally rather than imported from `lib/generated/graphql-types.ts` because
 * the server side of this wave (agent S1) had not landed at the time this file
 * was written — importing a codegen'd type that does not exist yet would block
 * every file below this one on a different agent's timeline.
 *
 * THAT DIFF HAS NOW BEEN DONE against the generated `FactCheck` /
 * `FactCheckOrganisation` / `FactCheckCitation` / `FactCheckClaim` in
 * `lib/generated/graphql-types.ts`. Every field matches by name and by inner
 * type. Three fields are LOOSER here than on the wire, all deliberately:
 *
 *   generated                          here
 *   createdAt: DateTime!               createdAt?: string | number | null
 *   attempts: Int!                     attempts?: number | null
 *   checkedByStatus: String!           checkedByStatus?: CheckedByStatus
 *
 * DO NOT "FIX" THOSE BY RE-POINTING AT THE GENERATED TYPE. `FactCheckRow`
 * describes two different objects that happen to share a name: a payload fresh
 * off the wire, AND a payload replayed out of `payload_json` on the device,
 * which may have been written by an older build of this app. The generated type
 * only ever describes the first. A row stored before `checkedByStatus` existed
 * genuinely does not carry it (see `CheckedByStatus` below), and the same is
 * true of any field added later. Adopting the server's non-null guarantees
 * would assert something stored rows do not honour, and the failure would land
 * at render time on the oldest rows rather than at the type boundary.
 *
 * The generated `FactCheckOrganisation` carries `organisation`, `url`,
 * `verdict`, `summary` and NOTHING ELSE — in particular no relevance score and
 * no reviewed-claim text. Relevance of a `checkedBy` entry to the article is
 * therefore not knowable client-side and is not attempted here; it is
 * guaranteed by the server's own gate before the row is ever sent.
 *
 * THE ONE FIELD THE OLD SERVER TYPE DID NOT HAVE: `checkedByStatus`. An empty
 * `checkedBy[]` is ambiguous on its own — it means either "nobody has
 * published" (the normal case) or "the ClaimReview lookup didn't run" (an
 * outage), and those two must never render the same. See `CheckedByStatus`.
 *
 * `status` and `verdict` are kept as plain `string` (not a closed union) on
 * purpose, matching the server's own un-enumerated `String` fields and
 * `fact-check-state.ts`'s "every normalizer has an unknown bucket" philosophy —
 * a model or a future server release can emit a token this build has never
 * seen, and the render layer must degrade to hedged copy, not throw.
 */

/** Lifecycle the server documents: `pending` and `running` are in flight,
 *  `complete` and `blocked` are terminal, `failed` is retried by the server's
 *  own recovery cron (never terminal from the client's point of view). See
 *  `isTerminalStatus` in `fact-check-state.ts`. */
export type FactCheckRunStatus = 'pending' | 'running' | 'complete' | 'failed' | 'blocked';

/**
 * Whether `checkedBy[]` is an ANSWER or an ABSENCE of one.
 *
 * `'searched'` + empty is the normal, honest "nobody has published on this"
 * outcome (measured ~96% of the corpus) — a real answer, not a gap.
 * `'unavailable'` + empty means the ClaimReview lookup itself didn't happen
 * (quota, transport failure, flag off): we know NOTHING about who has ruled on
 * this claim, and the render layer must say THAT, never "nobody has
 * published" — see `FactCheckSources.tsx`.
 *
 * A row stored before this field existed has no `checkedByStatus` at all;
 * every reader in this feature treats `undefined` as `'searched'`, the only
 * meaning an empty `checkedBy` ever had before this field was added.
 */
export type CheckedByStatus = 'searched' | 'unavailable';

/** An established fact-checking organisation's own published rating. `verdict`
 *  is that organisation's OWN wording ("Mostly False", "Pants on Fire",
 *  "Altered photo"), never mapped onto this feature's closed verdict
 *  vocabulary — see `describeOrganisationVerdict`. */
export interface FactCheckOrganisation {
    readonly organisation: string;
    readonly url?: string | null;
    readonly verdict?: string | null;
    readonly summary?: string | null;
}

/** Old name for {@link FactCheckOrganisation}, kept because
 *  `FactCheckSources.tsx` and `FactCheckCard.tsx` already import it under this
 *  name. */
export type FactCheckedByEntry = FactCheckOrganisation;

/** A grounding source consulted during synthesis. `uri` is stored verbatim
 *  (may be a redirect wrapper). */
export interface FactCheckCitation {
    readonly title?: string | null;
    readonly uri: string;
    readonly snippet?: string | null;
}

/** One checkable assertion lifted out of the article, with the server's
 *  assessment of it. `assessment` is an un-enumerated `String` server-side —
 *  see `describeAssessment`'s unknown bucket. */
export interface FactCheckClaim {
    readonly claim: string;
    readonly assessment: string;
    readonly note?: string | null;
}

/**
 * One fact check, as returned by the `factCheck(articleId)` query and as
 * stored verbatim in `payload_json` on the device.
 */
export interface FactCheckRow {
    readonly _id: string;
    /** Plain string — see the file header for why this is not `FactCheckRunStatus`. */
    readonly status: string;
    readonly verdict?: string | null;
    readonly summary?: string | null;
    readonly checkedBy: readonly FactCheckOrganisation[];
    /** See {@link CheckedByStatus}. Absent on a row stored before this field
     *  existed — every reader treats that as `'searched'`. */
    readonly checkedByStatus?: CheckedByStatus;
    readonly citations: readonly FactCheckCitation[];
    readonly claims: readonly FactCheckClaim[];
    readonly completedAt?: string | number | null;
    readonly createdAt?: string | number | null;
    readonly articleTitle?: string | null;
    readonly articleUrl?: string | null;
    readonly publicationName?: string | null;
    /** Model that answered, after failover. */
    readonly model?: string | null;
    /** Provider calls issued for this row (the crash-loop guard's counter). */
    readonly attempts?: number | null;
}
