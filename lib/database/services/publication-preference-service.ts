// Publication-Preference Service — WatermelonDB adapter for persona-v3
// `publication_preferences`. Weights are only ever written explicitly (user /
// feedback-tree / migration) — never auto-derived from visit history.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type PublicationPreferenceModel from '../models/PublicationPreference';
import type { PublicationPreferenceProvenance } from '../models/PublicationPreference';

const prefsCollection = database.get<PublicationPreferenceModel>('publication_preferences');

function normalizePublicationName(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
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
    (p) => normalizePublicationName(p.publicationName) === normalizePublicationName(input.publicationName),
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
        normalizePublicationName(p.publicationName) === normalizePublicationName(publicationName),
    );
    if (existing) await retirePreference(existing.id);
    return;
  }
  await upsertPreference({ publicationName, weight: PUBLICATION_PREF_WEIGHT[kind], provenance });
}
