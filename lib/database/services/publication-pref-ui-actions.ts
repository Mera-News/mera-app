// Source-preference UI actions (item 9, Wave B). The ONE entry point every
// ↑/↓ control in the app calls — the L2 publication list's `SourcePrefControl`
// (this repo) and the L1 country list's own controls (owned by a concurrent
// change; this module is the shared seam between the two).
//
// The friction this removes: before this module, `PublicationPreferencesScreen`
// carried its own hand-rolled apply/clear logic (see git history) and every new
// ↑/↓ surface would have had to re-derive the same 5-step dance (guard → read
// `before` → apply → change-log → sweep) or drift from it. Now there is exactly
// one place that knows how to write a boost/downrank/none, for either a named
// publication or a country scope, and every caller — including
// `PublicationPreferencesScreen` itself — routes through it.
//
// Deliberately NOT exposing `mute`: muting is a hard exclusion and stays a
// dedicated, confirm-free-but-explicit action on the `publication-preferences`
// screen (its 3-way boost/downrank/mute selector) — not part of the L1/L2 ↑/↓
// vocabulary, which item 9 defines as prioritise/deprioritise ONLY (a
// downrank is NOT a block; no retroactive purge, no confirm dialog).
//
// Concrete-kind writes (prioritised/deprioritised) route through
// `applyPersonaAction` — never a bare `setPreferenceKind`/`setScopePreferenceKind`
// — because the executor already owns the change-log row (Activity undo), the
// sweep decision, and the D18 feed-dirty flag (see
// `persona-action-executor.applyPersonaAction`, which marks the feed dirty at
// its own call site whenever a mutation applies and did not already purge).
// Nothing further is needed here for those two levels.
//
// `'none'` (clear) has no executor action — `SET_PUBLICATION_PREF` /
// `SET_SOURCE_SCOPE_PREF` both require a concrete `publicationPref` — so this
// module hand-appends the change-log row itself, exactly mirroring what the
// executor does for every other mutation. This mirrors
// `PublicationPreferencesScreen`'s pre-existing clear logic, which is why that
// screen's `handleClear`/`handleSetKind` now delegate here instead of
// duplicating it.

import { applyPersonaAction } from './persona-action-executor';
import * as publicationPreferenceService from './publication-preference-service';
import type { SourceScopeRef } from './publication-preference-service';
import * as changeLogService from './persona-change-log-service';
import {
  markFeedNeedsRefresh,
  runSweepFor,
  sweepForMutation,
} from './persona-mutation-sweeps';
import { ACTION_NAMES } from '../../news-harness/persona-management/action-names';
// Import-only: this module does not own lib/explore/**. Pure/RN-free (see its
// own header), so pulling it in here adds no native/DB coupling.
import { alpha2ToAlpha3 } from '../../explore/scopes';

/**
 * The L1/L2 vocabulary: three levels, no mute. `'none'` clears whatever is
 * currently set (a no-op write if nothing was set).
 */
export type SourcePrefUiLevel = 'none' | 'prioritised' | 'deprioritised';

/**
 * What the control is acting on.
 *
 *  - `publication`: matched by `publication_name` (source-pref's existing
 *    name-matching contract — no `source_id`).
 *  - `country`: a LIVE scope predicate ("prefer/deprioritise sources from
 *    India"), not an expansion into one row per matching publication.
 *    `countryAlpha2` is deliberately alpha-2 — the convention "Explore/sources"
 *    UI code speaks (see lib/explore/scopes.ts) — because that is the format
 *    every caller of this module already has on hand for a country row.
 *    `PublicationPreference.scopeValue` is ISO ALPHA-3; the conversion happens
 *    once, right here at the boundary, so alpha-2 never reaches the store and
 *    alpha-3 never leaks back out to a caller expecting alpha-2. A caller that
 *    already holds the canonical alpha-3 (e.g. a stored `PublicationPreference`
 *    row) must convert to alpha-2 with `alpha3ToAlpha2` before calling in —
 *    two conventions must never meet inside the store.
 */
export type SourcePrefUiTarget =
  | { readonly kind: 'publication'; readonly publicationName: string }
  | { readonly kind: 'country'; readonly countryAlpha2: string; readonly label: string };

export interface SetSourcePrefResult {
  /** Whether the write actually happened (false ⇒ bad/unmappable input, nothing was touched). */
  readonly applied: boolean;
}

const LEVEL_TO_PREF_KIND: Record<'prioritised' | 'deprioritised', 'boost' | 'deprioritize'> = {
  prioritised: 'boost',
  deprioritised: 'deprioritize',
};

/** Boost/downrank a named publication — routes through the executor, which owns everything else. */
async function setNamedPublicationLevel(
  publicationName: string,
  kind: 'boost' | 'deprioritize',
): Promise<SetSourcePrefResult> {
  const result = await applyPersonaAction(
    {
      action_type: ACTION_NAMES.SET_PUBLICATION_PREF,
      publicationId: publicationName,
      publicationPref: kind,
    },
    'user',
  );
  return { applied: result.applied };
}

/** Boost/downrank a country scope — routes through the executor, which owns everything else. */
async function setCountryScopeLevel(
  countryAlpha2: string,
  label: string,
  kind: 'boost' | 'deprioritize',
): Promise<SetSourcePrefResult> {
  const alpha3 = alpha2ToAlpha3(countryAlpha2);
  if (!alpha3) return { applied: false };
  const result = await applyPersonaAction(
    {
      action_type: ACTION_NAMES.SET_SOURCE_SCOPE_PREF,
      scopeKind: 'country',
      scopeValue: alpha3,
      scopeLabel: label,
      publicationPref: kind,
    },
    'user',
  );
  return { applied: result.applied };
}

/**
 * Clear a named-publication preference. No executor 'none' action exists, so
 * this hand-appends the change-log row and runs the same sweep policy the
 * executor would have (a mute IS a hard filter — un-muting/clearing must give
 * its casualties a second chance; every other before-state is a no-op sweep).
 */
async function clearNamedPublicationLevel(publicationName: string): Promise<SetSourcePrefResult> {
  const before = await publicationPreferenceService.getPreferenceKind(publicationName);
  await publicationPreferenceService.setPreferenceKind(publicationName, 'none', 'user');
  await changeLogService.append({
    actionType: ACTION_NAMES.SET_PUBLICATION_PREF,
    action: { targetId: publicationName, before, after: 'none' },
    source: 'user',
    summary: `Cleared publication preference: ${publicationName}`,
  });
  const purged = await runSweepFor(
    sweepForMutation({
      actionType: ACTION_NAMES.SET_PUBLICATION_PREF,
      prefBefore: before,
      prefAfter: 'none',
    }),
    ACTION_NAMES.SET_PUBLICATION_PREF,
  );
  if (!purged) markFeedNeedsRefresh();
  return { applied: true };
}

/**
 * Clear a country-scope preference. A scope can never be muted (the executor
 * rejects it, stage-scoring never derives a hard filter from one), so there is
 * nothing to retroactively sweep — unlike the named-publication clear above,
 * this never calls `sweepForMutation`/`runSweepFor`; it just dirties the feed
 * for a rescore. Mirrors `PublicationPreferencesScreen`'s pre-existing scope
 * clear exactly.
 */
async function clearCountryScopeLevel(
  countryAlpha2: string,
  label: string,
): Promise<SetSourcePrefResult> {
  const alpha3 = alpha2ToAlpha3(countryAlpha2);
  if (!alpha3) return { applied: false };
  const scope: SourceScopeRef = { scopeKind: 'country', scopeValue: alpha3 };
  const before = await publicationPreferenceService.getScopePreferenceKind(scope);
  await publicationPreferenceService.setScopePreferenceKind(scope, 'none', label, 'user');
  await changeLogService.append({
    actionType: ACTION_NAMES.SET_SOURCE_SCOPE_PREF,
    action: { targetId: `country:${alpha3}`, before, after: 'none' },
    source: 'user',
    summary: `Cleared source-scope preference: ${label}`,
  });
  markFeedNeedsRefresh();
  return { applied: true };
}

/**
 * Set (or clear) the source-preference level for a publication or a country
 * scope, from any ↑/↓ control in the app. The single entry point item 9
 * requires — never call `setPreferenceKind`/`setScopePreferenceKind` directly
 * from UI code.
 */
export async function setSourcePrefFromUi(
  target: SourcePrefUiTarget,
  level: SourcePrefUiLevel,
): Promise<SetSourcePrefResult> {
  if (level === 'none') {
    return target.kind === 'publication'
      ? clearNamedPublicationLevel(target.publicationName)
      : clearCountryScopeLevel(target.countryAlpha2, target.label);
  }
  const kind = LEVEL_TO_PREF_KIND[level];
  return target.kind === 'publication'
    ? setNamedPublicationLevel(target.publicationName, kind)
    : setCountryScopeLevel(target.countryAlpha2, target.label, kind);
}
