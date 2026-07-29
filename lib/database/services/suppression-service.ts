// Suppression Service — WatermelonDB adapter for persona-v3
// `persona_suppressions` (negative preferences / show-less escalations).
// strength ≥ 0.8 → hard filter; below that → score penalty. Soft ones decay
// via `expires_at` (default +30d).

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type PersonaSuppressionModel from '../models/PersonaSuppression';
import type {
  PersonaSuppressionSource,
  PersonaSuppressionKind,
} from '../models/PersonaSuppression';

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
  /** v46. What the filter matches; omitted ⇒ stored NULL ⇒ reads as 'keyword'. */
  kind?: PersonaSuppressionKind;
  /** v46. The single token the non-keyword kinds compare against. */
  value?: string;
}

/**
 * Read-side kind resolver. A NULL/absent `kind` column (every pre-v46 row, and
 * every row written by the old keyword-only paths) means 'keyword' — that is
 * what keeps the migration backfill-free.
 */
export function kindOf(s: {
  kind?: PersonaSuppressionKind | null;
}): PersonaSuppressionKind {
  return s.kind ?? 'keyword';
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
      // Left NULL when omitted — NULL kind reads as 'keyword' (kindOf).
      s.kind = input.kind ?? null;
      s.value = input.value ?? null;
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

/**
 * Undo a retire: flip `status` back to 'active', keeping the ORIGINAL
 * `expires_at` untouched.
 *
 * Consequence, deliberate: a SOFT row whose original expiry has already passed
 * comes back inert — `getActive()` filters it out again on the next read, so
 * reactivating a long-dead soft suppression is a no-op rather than a silent
 * 30-day extension. Hard rows (strength ≥ HARD_SUPPRESSION_STRENGTH) carry a
 * null expiry, so reactivating one always takes effect.
 */
export async function reactivateSuppression(suppressionId: string): Promise<void> {
  const record = await suppressionsCollection.find(suppressionId);
  await database.write(async () => {
    await record.update((s) => {
      s.status = 'active';
    });
  });
}
