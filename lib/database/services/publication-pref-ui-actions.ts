// Source-preference UI actions (item 9, Wave B). The ONE entry point every
// More/Fewer control in the app calls — the publication page, the Sources
// screen's rows and search, and "Fewer from" in an article's menu.
//
// The friction this removes: before this module, `PublicationPreferencesScreen`
// carried its own hand-rolled apply/clear logic (see git history) and every new
// ↑/↓ surface would have had to re-derive the same 5-step dance (guard → read
// `before` → apply → change-log → sweep) or drift from it. Now there is exactly
// one place that knows how to write a boost/downrank/none, for either a named
// publication or a country scope, and every caller — including
// `PublicationPreferencesScreen` itself — routes through it.
//
// `muted` is Not preferred, a hard exclusion. The row is written at once and the
// live filters hide the publication from the Feed, but the purge waits for the
// toast's Undo window: an excluded row loses its score and an undo sends it back
// through scoring. The caller runs `commitPurge()` when the toast closes. If the
// app dies first nothing is lost: every purge reads the live filters, so the next
// one (each gate propagation, each filter change) takes these rows too.
//
// Boost and downrank writes route through
// `applyPersonaAction` — never a bare `setPreferenceKind`/`setScopePreferenceKind`
// — because the executor already owns the change-log row (Activity undo) and
// the sweep decision. Nothing further is needed here for those two levels.
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
import { runSweepFor, sweepForMutation } from './persona-mutation-sweeps';
import { ACTION_NAMES } from '../../news-harness/persona-management/action-names';
// Import-only: this module does not own lib/explore/**. Pure/RN-free (see its
// own header), so pulling it in here adds no native/DB coupling.
import { alpha2ToAlpha3 } from '../../explore/scopes';
import {
  publisherPrefNames,
  resolvePrefLevel,
  type SourcePrefUiLevel,
} from '../../algorithms/publication-pref-level';

/**
 * `'none'` clears whatever is currently set (a no-op write if nothing was
 * set). A country can never be `'muted'`. Defined in the pure
 * `publication-pref-level` module so list rows can read it without the DB.
 */
export type { SourcePrefUiLevel };

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
  /**
   * ONE publication under every name it is known by (its source names, the
   * publisher name, the name the entry point showed). Build `names` with
   * `resolvePublicationPrefNames` (publisher-source-names.ts). A set writes
   * one row per name whose level differs, and a clear retires every one of
   * them. The publication page, the Sources rows and "Fewer from" all use
   * this, so a preference reaches every source the publication publishes as.
   */
  | { readonly kind: 'publisher'; readonly names: readonly string[] }
  | { readonly kind: 'country'; readonly countryAlpha2: string; readonly label: string };

export interface SetSourcePrefResult {
  /** Whether the write actually happened (false ⇒ bad/unmappable input, nothing was touched). */
  readonly applied: boolean;
  /** The change-log row a boost/downrank wrote. An undo reverts THIS row
   *  (`revertChange`, compare-and-set) instead of writing a fresh 'none',
   *  which clobbered any newer change and logged as a new user action. */
  readonly changeLogId?: string;
  /** Every change-log row the write produced: one per name for a
   *  `publisher` target. Undo with `revertSourcePrefChange`, which reverts
   *  all of them. `changeLogId` is the first, for single-name callers. */
  readonly changeLogIds?: readonly string[];
  /** Set when a mute was written. Call it once the Undo window closes; a
   *  second call does nothing, and after an undo it purges nothing new. */
  readonly commitPurge?: () => Promise<void>;
}

const LEVEL_TO_PREF_KIND = {
  prioritised: 'boost',
  muted: 'mute',
} as const;

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
  return { applied: result.applied, changeLogId: result.changeLogId };
}

/** The executor's mute, minus its sweep: see the header. One name of an action. */
async function muteNamedPublication(publicationName: string): Promise<SetSourcePrefResult> {
  const before = await publicationPreferenceService.getPreferenceKind(publicationName);
  await publicationPreferenceService.setPreferenceKind(publicationName, 'mute', 'user');
  const row = await changeLogService.append({
    actionType: ACTION_NAMES.SET_PUBLICATION_PREF,
    action: { targetId: publicationName, before, after: 'mute' },
    source: 'user',
    summary: `Set publication preference: ${publicationName} → mute`,
  });
  return { applied: true, changeLogId: row.id };
}

/** One purge per action, however many names it wrote. */
function purgeOnce(): () => Promise<void> {
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await runSweepFor('purge', ACTION_NAMES.SET_PUBLICATION_PREF);
  };
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
  return { applied: result.applied, changeLogId: result.changeLogId };
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
  const row = await changeLogService.append({
    actionType: ACTION_NAMES.SET_PUBLICATION_PREF,
    action: { targetId: publicationName, before, after: 'none' },
    source: 'user',
    summary: `Cleared publication preference: ${publicationName}`,
  });
  await runSweepFor(
    sweepForMutation({
      actionType: ACTION_NAMES.SET_PUBLICATION_PREF,
      prefBefore: before,
      prefAfter: 'none',
    }),
    ACTION_NAMES.SET_PUBLICATION_PREF,
  );
  return { applied: true, changeLogId: row?.id };
}

/**
 * Clear a country-scope preference. A scope can never be muted (the executor
 * rejects it, stage-scoring never derives a hard filter from one), so there is
 * nothing to retroactively sweep — unlike the named-publication clear above,
 * this never calls `sweepForMutation`/`runSweepFor`; the next scoring pass
 * picks the change up. Mirrors `PublicationPreferencesScreen`'s pre-existing scope
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
  const row = await changeLogService.append({
    actionType: ACTION_NAMES.SET_SOURCE_SCOPE_PREF,
    action: { targetId: `country:${alpha3}`, before, after: 'none' },
    source: 'user',
    summary: `Cleared source-scope preference: ${label}`,
  });
  return { applied: true, changeLogId: row.id };
}

/**
 * Set or clear one publication across all its names. Only names whose level
 * differs are written, so pressing the level already shown logs nothing, and
 * an undo reverts exactly what this press changed.
 */
async function setPublisherLevel(
  rawNames: readonly string[],
  level: SourcePrefUiLevel,
): Promise<SetSourcePrefResult> {
  const names = publisherPrefNames(rawNames);
  if (names.length === 0) return { applied: false };
  const ids: string[] = [];
  let muted = false;
  for (const name of names) {
    const kind = await publicationPreferenceService.getPreferenceKind(name);
    if (kind === (level === 'none' ? 'none' : LEVEL_TO_PREF_KIND[level])) continue;
    let res: SetSourcePrefResult;
    if (level === 'none') res = await clearNamedPublicationLevel(name);
    else if (level === 'muted') {
      res = await muteNamedPublication(name);
      muted = true;
    } else res = await setNamedPublicationLevel(name, LEVEL_TO_PREF_KIND[level]);
    if (res.changeLogId) ids.push(res.changeLogId);
    // A refused write stops the run; what was written stays undoable.
    if (!res.applied) return { applied: false, changeLogId: ids[0], changeLogIds: ids };
  }
  // Nothing differed: the state already is `level`, which is a success.
  return { applied: true, changeLogId: ids[0], changeLogIds: ids, ...(muted ? { commitPurge: purgeOnce() } : {}) };
}

/**
 * The current level of one publication across all its names (a mute wins over
 * a preference). The async twin of `resolvePrefLevel`, for a caller without an
 * observed row set.
 */
export async function getPublisherPrefLevel(names: readonly string[]): Promise<SourcePrefUiLevel> {
  if (names.length === 0) return 'none';
  const rows = await publicationPreferenceService.getActiveNamedPublications();
  return resolvePrefLevel(rows, names);
}

/**
 * Undo a `setSourcePrefFromUi` result: reverts every change-log row it wrote,
 * newest first, each compare-and-set (a newer change to that name wins and
 * is left alone). True when at least one row was reverted.
 */
export async function revertSourcePrefChange(result: SetSourcePrefResult): Promise<boolean> {
  const ids = result.changeLogIds ?? (result.changeLogId ? [result.changeLogId] : []);
  let reverted = false;
  for (const id of [...ids].reverse()) {
    if (await changeLogService.revertChange(id)) reverted = true;
  }
  return reverted;
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
  if (target.kind === 'publisher') return setPublisherLevel(target.names, level);
  if (level === 'muted') {
    return target.kind === 'publication' ? setPublisherLevel([target.publicationName], level) : { applied: false };
  }
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
