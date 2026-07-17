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
