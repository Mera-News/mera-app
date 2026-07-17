// Suppression Service — WatermelonDB adapter for persona-v3
// `persona_suppressions` (negative preferences / show-less escalations).
// strength ≥ 0.8 → hard filter; below that → score penalty. Soft ones decay
// via `expires_at` (default +30d).

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type PersonaSuppressionModel from '../models/PersonaSuppression';
import type { PersonaSuppressionSource } from '../models/PersonaSuppression';

const suppressionsCollection = database.get<PersonaSuppressionModel>('persona_suppressions');

/** Default soft-suppression lifetime: 30 days. */
export const SUPPRESSION_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** strength at or above which a suppression is a hard filter (no expiry). */
export const HARD_SUPPRESSION_STRENGTH = 0.8;

export interface AddSuppressionInput {
  pattern: string;
  keywords?: string[];
  strength: number;
  source: PersonaSuppressionSource;
  /** Explicit expiry; defaults to +30d for soft suppressions, none for hard. */
  expiresAt?: number | null;
}

export async function addSuppression(
  input: AddSuppressionInput,
): Promise<PersonaSuppressionModel> {
  const strength = Math.max(0, Math.min(1, input.strength));
  const defaultExpiry =
    strength >= HARD_SUPPRESSION_STRENGTH ? null : Date.now() + SUPPRESSION_DEFAULT_TTL_MS;
  return database.write(async () => {
    return suppressionsCollection.create((s) => {
      s.pattern = input.pattern.trim();
      s.keywords = input.keywords ?? [];
      s.strength = strength;
      s.source = input.source;
      s.status = 'active';
      s.expiresAt = input.expiresAt !== undefined ? input.expiresAt : defaultExpiry;
      s.createdAt = new Date();
    });
  });
}

/** Active, non-expired suppressions — what the scoring engine consumes. */
export async function getActive(now = Date.now()): Promise<PersonaSuppressionModel[]> {
  const rows = await suppressionsCollection.query(Q.where('status', 'active')).fetch();
  return rows.filter((s) => s.expiresAt == null || s.expiresAt > now);
}

/** All suppressions (management UI / audit). */
export async function getAll(): Promise<PersonaSuppressionModel[]> {
  return suppressionsCollection.query(Q.sortBy('created_at', Q.desc)).fetch();
}

/** Reactive query of active rows (expiry filtering is the consumer's job). */
export function observeActive() {
  return suppressionsCollection.query(Q.where('status', 'active')).observe();
}

export async function retireSuppression(suppressionId: string): Promise<void> {
  const record = await suppressionsCollection.find(suppressionId);
  await database.write(async () => {
    await record.update((s) => {
      s.status = 'retired';
    });
  });
}
