/**
 * The on-device fact-check payload shape — the stable import point for the
 * render layer (`FactCheckPanel`, `FactCheckSources`, `FactCheckCard`,
 * `fact-check-state.ts`).
 *
 * WHY THIS FILE EXISTS. `FactCheckRow` used to alias the CODEGEN'D `FactCheck`
 * GraphQL type (`lib/generated/graphql-types.ts`). That type disappears the
 * moment the server schema is torn down in a later wave, which would have taken
 * every render-layer file down with it. Fact-checking is now entirely on-device
 * (`fact-check-runner.ts`), so the render layer has no business depending on
 * anything server-generated any more.
 *
 * These are RE-EXPORTS, not fresh declarations. `fact-check-runner.ts` (F2's
 * file) already declares the canonical shape — deliberately "structurally
 * identical to the GraphQL `FactCheck` row" per its own header, because that is
 * exactly what let the render layer ship unchanged across the pivot. Redeclaring
 * the same fields here would just be a second copy that can silently drift from
 * what the runner actually writes into `payload_json`; aliasing it keeps there
 * being exactly one definition.
 */

import type {
    FactCheckPayload,
    FactCheckOrganisationPayload,
    FactCheckCitationPayload,
    FactCheckClaimPayload,
    FactCheckRunStatus,
    CheckedByStatus,
} from './fact-check-runner';

/** One fact check, as stored in `payload_json` and read back verbatim. */
export type FactCheckRow = FactCheckPayload;

/** An established fact-checking organisation's own published rating —
 *  `checkedBy[]`. `verdict` is that organisation's OWN wording, never mapped
 *  onto our closed vocabulary. */
export type FactCheckOrganisation = FactCheckOrganisationPayload;

/** Old name for {@link FactCheckOrganisation}, kept because
 *  `FactCheckSources.tsx` and `FactCheckCard.tsx` already import it. */
export type FactCheckedByEntry = FactCheckOrganisation;

/** A grounding source consulted during synthesis. */
export type FactCheckCitation = FactCheckCitationPayload;

/** One checkable assertion lifted out of the claim, with the runner's
 *  assessment of it. */
export type FactCheckClaim = FactCheckClaimPayload;

export type { FactCheckRunStatus };

/**
 * Whether `checkedBy[]` is an ANSWER or an ABSENCE of one — see
 * {@link FactCheckPayload.checkedByStatus} for the full rationale.
 * `'searched'` + empty is the normal, honest "nobody has published on this"
 * outcome; `'unavailable'` + empty means the ClaimReview lookup itself didn't
 * happen, and the render layer must say THAT, never "nobody has published".
 * Undefined (a pre-tri-state stored row) is treated as `'searched'` — the only
 * meaning an empty `checkedBy` ever had before this field existed.
 */
export type { CheckedByStatus };
