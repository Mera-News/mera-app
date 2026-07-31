// Per-scope "how many top headlines should Mera read for me" depth.
//
// Storage is the `settings` KV table, one row per OVERRIDDEN scope, keyed
// `headline_depth:<SCOPE KEY>` where the scope key is an uppercase country code
// or 'GLOBAL'. Absence is the default — nothing is written to get default
// behaviour, and resetting a scope DELETES its row rather than writing the
// default value. That matters for more than tidiness: if the shipped default
// ever moves, every scope the user never touched moves with it, while the ones
// they deliberately set stay put. Writing the default at onboarding time would
// silently freeze every user at whatever the default was on the day they
// installed.
//
// No migration: `settings` already exists and rows are created on demand. This
// mirrors the questionnaire-level KV pattern in fact-service.ts.

import {
  getSettingsByPrefix,
  setSetting,
  deleteSetting,
} from './setting-service';
import {
  MAX_HEADLINE_DEPTH,
  GLOBAL_SCOPE_KEY,
} from '@/lib/news-harness/scoring-engine/retrieval-profile';
import { HEADLINE_DEPTH_UI_ENABLED } from '@/lib/config/feature-gates';

const KEY_PREFIX = 'headline_depth:';

/** `settings` key for a scope. Country codes are normalized to uppercase so a
 *  lower-cased caller can never create a second row for the same scope. */
export function headlineDepthKey(scopeKey: string): string {
  return `${KEY_PREFIX}${scopeKey.trim().toUpperCase()}`;
}

/**
 * All per-scope depth overrides as `{ SCOPEKEY: depth }`.
 *
 * Only scopes the user actually set appear. Unparseable or out-of-range rows
 * are skipped rather than surfaced — a corrupt row must degrade that ONE scope
 * to the default, never fail the feed sync that reads this.
 *
 * SHIP GATE: returns `{}` — no overrides, default behaviour everywhere — while
 * `HEADLINE_DEPTH_UI_ENABLED` is false, WITHOUT deleting anything. This is the
 * single funnel from storage into `buildRetrievalProfile`, so gating it here is
 * what makes already-stored rows inert on a ROLLBACK, rather than only stopping
 * new ones from being written. See `lib/config/feature-gates.ts` for why that
 * matters (an unknown `limit` field empties the feed on today's prod schema).
 */
export async function getHeadlineDepths(): Promise<Record<string, number>> {
  if (!HEADLINE_DEPTH_UI_ENABLED) return {};
  const rows = await getSettingsByPrefix(KEY_PREFIX);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(rows)) {
    const scopeKey = key.slice(KEY_PREFIX.length);
    if (!scopeKey) continue;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_HEADLINE_DEPTH) {
      continue;
    }
    out[scopeKey] = parsed;
  }
  return out;
}

/** Set one scope's depth. Clamped to [0, MAX_HEADLINE_DEPTH] — the server
 *  rejects anything above its own maximum with a 400, and a stored setting must
 *  never be able to fail a feed sync. */
export async function setHeadlineDepth(
  scopeKey: string,
  depth: number,
): Promise<void> {
  const clamped = Math.max(0, Math.min(MAX_HEADLINE_DEPTH, Math.round(depth)));
  await setSetting(headlineDepthKey(scopeKey), String(clamped));
}

/** Reset one scope to the shipped default by REMOVING its override. */
export async function clearHeadlineDepth(scopeKey: string): Promise<void> {
  await deleteSetting(headlineDepthKey(scopeKey));
}

export { GLOBAL_SCOPE_KEY };
