// Publication-Preference Service — WatermelonDB adapter for persona-v3
// `publication_preferences`. Weights are only ever written explicitly (user /
// feedback-tree / migration) — never auto-derived from visit history.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type PublicationPreferenceModel from '../models/PublicationPreference';
import type {
  PublicationPreferenceProvenance,
  SourceScopeKind,
} from '../models/PublicationPreference';

const prefsCollection = database.get<PublicationPreferenceModel>('publication_preferences');

function normalizePublicationName(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * source-pref v47 (D6). A row is a NAMED-PUBLICATION preference only while it
 * carries no `scope_kind`. Every name-matching site funnels through this so a
 * scope row labelled "India" can never be mistaken for a publication called
 * "India" — the two live in one table precisely so the screen, executor, revert
 * and sweeps don't have to branch on two collections.
 */
function isNamedPublicationRow(p: PublicationPreferenceModel): boolean {
  return p.scopeKind == null;
}

/** Normalized scope token (ISO alpha-3 for `country`). Empty ⇒ null. */
function normalizeScopeValue(s: string): string {
  return s.trim().toUpperCase();
}

export interface UpsertPublicationPreferenceInput {
  publicationName: string;
  sourceCountryCode?: string | null;
  weight: number;
  provenance?: PublicationPreferenceProvenance;
}

/**
 * Creates or updates the preference for a publication (matched by normalized
 * name). Re-activates a retired row on upsert. Returns the record.
 */
export async function upsertPreference(
  input: UpsertPublicationPreferenceInput,
): Promise<PublicationPreferenceModel> {
  const clamped = Math.max(-1, Math.min(1, input.weight));
  const all = await prefsCollection.query().fetch();
  const existing = all.find(
    (p) =>
      isNamedPublicationRow(p) &&
      normalizePublicationName(p.publicationName) === normalizePublicationName(input.publicationName),
  );

  return database.write(async () => {
    const now = new Date();
    if (existing) {
      await existing.update((p) => {
        p.weight = clamped;
        p.status = 'active';
        if (input.sourceCountryCode !== undefined) p.sourceCountryCode = input.sourceCountryCode ?? null;
        p.updatedAt = now;
      });
      return existing;
    }
    return prefsCollection.create((p) => {
      p.publicationName = input.publicationName.trim();
      p.sourceCountryCode = input.sourceCountryCode ?? null;
      p.weight = clamped;
      p.status = 'active';
      p.provenance = input.provenance ?? 'user';
      p.createdAt = now;
      p.updatedAt = now;
    });
  });
}

/** Active preferences only — what the scoring engine consumes. */
export async function getActive(): Promise<PublicationPreferenceModel[]> {
  return prefsCollection.query(Q.where('status', 'active')).fetch();
}

/** All preferences (management UI). */
export async function getAll(): Promise<PublicationPreferenceModel[]> {
  return prefsCollection.query().fetch();
}

/** Reactive query of active preferences. */
export function observeActive() {
  return prefsCollection.query(Q.where('status', 'active')).observe();
}

/** Retires a preference (soft delete; history preserved for the audit log). */
export async function retirePreference(preferenceId: string): Promise<void> {
  const record = await prefsCollection.find(preferenceId);
  await database.write(async () => {
    await record.update((p) => {
      p.status = 'retired';
      p.updatedAt = new Date();
    });
  });
}

// ---------------------------------------------------------------------------
// Pref-kind surface (feedback tree / persona-action executor)
//
// The feedback tree and agent speak in coarse KINDS ('boost' / 'deprioritize' /
// 'mute') rather than raw weights. These map each kind to a canonical stored
// weight (and back), so a leaf can set/read/revert a publication preference
// without knowing the weight arithmetic.
// ---------------------------------------------------------------------------

export type PublicationPrefKind = 'boost' | 'deprioritize' | 'mute';

/** Canonical weight each pref kind writes. `mute` ≈ block (-1). */
export const PUBLICATION_PREF_WEIGHT: Record<PublicationPrefKind, number> = {
  boost: 0.5,
  deprioritize: -0.5,
  mute: -1,
};

/** Classify a stored weight back into the pref kind it represents (null ≈ neutral). */
export function weightToPrefKind(weight: number): PublicationPrefKind | null {
  if (weight <= -0.9) return 'mute';
  if (weight < 0) return 'deprioritize';
  if (weight > 0) return 'boost';
  return null;
}

/** The current pref kind for a publication (matched by normalized name), or 'none'. */
export async function getPreferenceKind(
  publicationName: string,
): Promise<PublicationPrefKind | 'none'> {
  const all = await prefsCollection.query().fetch();
  const existing = all.find(
    (p) =>
      p.status === 'active' &&
      isNamedPublicationRow(p) &&
      normalizePublicationName(p.publicationName) === normalizePublicationName(publicationName),
  );
  if (!existing) return 'none';
  return weightToPrefKind(existing.weight) ?? 'none';
}

/**
 * Set (or clear) the pref kind for a publication. `'none'` retires any active
 * preference; a concrete kind upserts its canonical weight. Additive wrapper
 * over upsertPreference/retirePreference used by the persona-action executor
 * (apply + revert paths).
 */
export async function setPreferenceKind(
  publicationName: string,
  kind: PublicationPrefKind | 'none',
  provenance: PublicationPreferenceProvenance = 'feedback',
): Promise<void> {
  if (kind === 'none') {
    const all = await prefsCollection.query().fetch();
    const existing = all.find(
      (p) =>
        p.status === 'active' &&
        isNamedPublicationRow(p) &&
        normalizePublicationName(p.publicationName) === normalizePublicationName(publicationName),
    );
    if (existing) await retirePreference(existing.id);
    return;
  }
  await upsertPreference({ publicationName, weight: PUBLICATION_PREF_WEIGHT[kind], provenance });
}

// ---------------------------------------------------------------------------
// Source SCOPE preferences (source-pref v47, D2/D6)
//
// A scope is a LIVE predicate evaluated against a suggestion's `country_code`
// at render time — NOT an expansion into one row per matching publication. It
// shares this table (and therefore the Source-preferences screen, the executor,
// revertChange and the sweeps) with named-publication rows; `scope_kind` is the
// only thing that tells them apart.
// ---------------------------------------------------------------------------

export interface SourceScopeRef {
  /** Only `'country'` today. */
  scopeKind: SourceScopeKind;
  /** The token compared at render time — ISO alpha-3 for `country`. */
  scopeValue: string;
}

/** Find the ACTIVE-or-retired row for a scope (matched by kind + normalized value). */
async function findScopeRow(
  scope: SourceScopeRef,
  activeOnly: boolean,
): Promise<PublicationPreferenceModel | undefined> {
  const value = normalizeScopeValue(scope.scopeValue);
  if (value === '') return undefined;
  const all = await prefsCollection.query().fetch();
  return all.find(
    (p) =>
      p.scopeKind === scope.scopeKind &&
      normalizeScopeValue(p.scopeValue ?? '') === value &&
      (!activeOnly || p.status === 'active'),
  );
}

export interface UpsertSourceScopeInput extends SourceScopeRef {
  /** Human display label ("India") — stored in `publication_name` so the
   *  existing screen renders the row unchanged (D6). */
  label: string;
  weight: number;
  provenance?: PublicationPreferenceProvenance;
}

/** Creates or updates a source-scope preference. Re-activates a retired row. */
export async function upsertScopePreference(
  input: UpsertSourceScopeInput,
): Promise<PublicationPreferenceModel> {
  const clamped = Math.max(-1, Math.min(1, input.weight));
  const value = normalizeScopeValue(input.scopeValue);
  const existing = await findScopeRow(input, false);

  return database.write(async () => {
    const now = new Date();
    if (existing) {
      await existing.update((p) => {
        p.publicationName = input.label.trim();
        p.weight = clamped;
        p.status = 'active';
        p.updatedAt = now;
      });
      return existing;
    }
    return prefsCollection.create((p) => {
      p.publicationName = input.label.trim();
      p.sourceCountryCode = null;
      p.scopeKind = input.scopeKind;
      p.scopeValue = value;
      p.weight = clamped;
      p.status = 'active';
      p.provenance = input.provenance ?? 'user';
      p.createdAt = now;
      p.updatedAt = now;
    });
  });
}

/** The current pref kind for a source scope, or 'none'. */
export async function getScopePreferenceKind(
  scope: SourceScopeRef,
): Promise<PublicationPrefKind | 'none'> {
  const existing = await findScopeRow(scope, true);
  if (!existing) return 'none';
  return weightToPrefKind(existing.weight) ?? 'none';
}

/**
 * Set (or clear) the pref kind for a source scope. `'none'` retires any active
 * row; a concrete kind upserts its canonical weight. Mirrors
 * `setPreferenceKind` so the executor's apply + revert paths are the same shape
 * for both row kinds.
 *
 * `label` is only consulted when a row is created/updated; on `'none'` it is
 * ignored (the row is retired, keeping its label for the audit trail).
 */
export async function setScopePreferenceKind(
  scope: SourceScopeRef,
  kind: PublicationPrefKind | 'none',
  label: string,
  provenance: PublicationPreferenceProvenance = 'feedback',
): Promise<void> {
  if (kind === 'none') {
    const existing = await findScopeRow(scope, true);
    if (existing) await retirePreference(existing.id);
    return;
  }
  await upsertScopePreference({
    ...scope,
    label,
    weight: PUBLICATION_PREF_WEIGHT[kind],
    provenance,
  });
}

/** Active SCOPE rows only (what the render-time context loader consumes). */
export async function getActiveScopes(): Promise<PublicationPreferenceModel[]> {
  const active = await getActive();
  return active.filter((p) => p.scopeKind != null);
}

/** Active NAMED-PUBLICATION rows only — what `pubPrefs` and the muted-publication
 *  hard-filter derivation must see, so a scope never leaks into either. */
export async function getActiveNamedPublications(): Promise<PublicationPreferenceModel[]> {
  const active = await getActive();
  return active.filter(isNamedPublicationRow);
}
