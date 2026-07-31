// Headline-depth screen — everything that is not React.
//
// RN-free on purpose (it imports only pure logic + the DB services), so the
// scope derivation, the option ladder and the save action are all unit-testable
// without rendering anything.

import {
  buildRetrievalProfile,
  DEFAULT_HEADLINE_LIMIT_PER_SCOPE,
  GLOBAL_SCOPE_KEY,
  MAX_HEADLINE_DEPTH,
  type RetrievalLocationInput,
} from '@/lib/news-harness/scoring-engine/retrieval-profile';
import {
  clearHeadlineDepth,
  setHeadlineDepth,
} from '@/lib/database/services/headline-depth-service';

/** One adjustable section of the feed. `key` is what `headlineDepthByScope` is
 *  keyed on: an ISO **alpha-2** country code (matching `locations.countryCode`,
 *  which `buildRetrievalProfile` uppercases straight into `scope.countryCode`)
 *  or the literal 'GLOBAL'. Storing an alpha-3 here would silently do nothing —
 *  `depthFor('IND')` never matches the scope emitted as `IN`. */
export interface HeadlineScopeRow {
  readonly key: string;
  readonly isGlobal: boolean;
  /** alpha-2, empty for the GLOBAL row. */
  readonly countryCode: string;
}

/**
 * The sections the user can actually adjust, in the exact order and with the
 * exact keys the feed sync will send.
 *
 * Derived by running the real `buildRetrievalProfile` rather than re-filtering
 * locations here — that is what keeps the role filter, the expired-travel
 * exclusion, the 5-country cap, the weight ordering and the trailing GLOBAL
 * scope from drifting apart from what is on the wire.
 *
 * Deliberately called WITHOUT `headlineDepthByScope`: with a depth map in play,
 * "override equal to the default" and "no override at all" both collapse to an
 * omitted `limit`, and this screen has to tell those two apart.
 */
export function headlineScopeRows(
  locations: readonly RetrievalLocationInput[],
  nowMs?: number,
): HeadlineScopeRow[] {
  const { headlineScopes } = buildRetrievalProfile({
    topics: [],
    locations: locations as RetrievalLocationInput[],
    nowMs,
  });
  return headlineScopes.map((s) =>
    s.scope === 'GLOBAL'
      ? { key: GLOBAL_SCOPE_KEY, isGlobal: true, countryCode: '' }
      : { key: s.countryCode ?? '', isGlobal: false, countryCode: s.countryCode ?? '' },
  );
}

/**
 * The depths offered in the UI, ascending.
 *
 * Derived from the shipped default rather than hard-coded, so moving
 * `DEFAULT_HEADLINE_LIMIT_PER_SCOPE` moves the ladder with it and needs no copy
 * change and no re-translation.
 *
 * **Never offers 0.** The service still clamps to [0, MAX] because a non-UI
 * caller may legitimately ask for it, but a tappable "0" is a section that
 * silently goes empty with nothing on screen explaining why — see PU-24.
 */
export function headlineDepthOptions(
  defaultDepth: number = DEFAULT_HEADLINE_LIMIT_PER_SCOPE,
): number[] {
  const base = Math.max(1, Math.min(MAX_HEADLINE_DEPTH, Math.round(defaultDepth)));
  const candidates = [
    Math.max(1, Math.round(base / 2)),
    base,
    Math.min(MAX_HEADLINE_DEPTH, base * 2),
    MAX_HEADLINE_DEPTH,
  ];
  return Array.from(new Set(candidates)).sort((a, b) => a - b);
}

/**
 * Apply the user's choice for one scope.
 *
 * Choosing the default DELETES the row instead of writing the default value —
 * absence is the default everywhere downstream, and a scope the user never
 * pinned should follow the shipped default if it ever moves.
 */
export async function chooseHeadlineDepth(
  scopeKey: string,
  depth: number,
  defaultDepth: number = DEFAULT_HEADLINE_LIMIT_PER_SCOPE,
): Promise<void> {
  if (Math.round(depth) === Math.round(defaultDepth)) {
    await clearHeadlineDepth(scopeKey);
    return;
  }
  await setHeadlineDepth(scopeKey, depth);
}

export { DEFAULT_HEADLINE_LIMIT_PER_SCOPE, GLOBAL_SCOPE_KEY, MAX_HEADLINE_DEPTH };
