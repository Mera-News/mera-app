// scoring-engine — privacy-lean retrieval profile builder for feed sync
// (Persona v3, Wave 7b M-P4).
//
// PURE / RN-FREE: this module must never import react-native, WatermelonDB,
// expo, or any lib/database/* module. It takes plain snapshot inputs (already
// read from the on-device DB by the RN-coupled caller, feed-sync-steps.ts)
// and returns a plain, server-bound profile.
//
// Privacy-lean intent: only what's strictly needed to retrieve candidate
// articles ever leaves the device.
//   - Negative-weight topics, suppressed/retired topics, and suppressions
//     are NEVER included here — they stay on-device and are only used for
//     on-device (Mera Protocol) scoring, never sent to the server.
//   - The full location list (cities, regions, exact weights, roles) is
//     NEVER sent — only a coarse, deduped set of COUNTRY codes (plus a
//     trailing GLOBAL scope) is derived, for headline retrieval only.
//   - Only topic texts + a per-topic retrieval limit + the derived headline
//     scopes leave the device. No raw weights, fact weights, or location
//     ids are included in the output.

import { normalizeTopicText } from '../persona-management/persona-migration';

export interface RetrievalTopicInput {
  topicId: string;
  text: string;
  weight: number; // topic.weight
  highPriority: boolean;
  factWeight?: number | null; // owning fact.weight; null/undefined ⇒ 1.0
  factId?: string | null; // owning fact; a factless topic shares with no other
  createdAtMs?: number; // topic age, for the fair order
}

export interface RetrievalLocationInput {
  countryCode: string;
  role: string; // 'home'|'work'|'travel'|'family'|'partner_family'|'interest'
  weight: number;
  validUntilMs?: number | null;
}

export interface BuildRetrievalProfileInput {
  topics: RetrievalTopicInput[];
  locations: RetrievalLocationInput[];
  nowMs?: number; // default Date.now()
  headlineLimitPerScope?: number; // default DEFAULT_HEADLINE_LIMIT_PER_SCOPE
  /**
   * Per-scope depth overrides, keyed by scope key: an uppercase country code,
   * or 'GLOBAL'. A scope ABSENT from this map uses `headlineLimitPerScope` —
   * absence is the default, so nothing needs writing to get default behaviour
   * and clearing an override is a delete, not a write of the default value.
   *
   * Values are clamped to [0, MAX_HEADLINE_DEPTH]; the server rejects anything
   * above its own maximum of 25 with a 400, so clamping here is what keeps a
   * stale or hand-edited setting from failing the whole feed sync.
   */
  headlineDepthByScope?: Readonly<Record<string, number>>;
}

type HeadlineScopeKind = 'COUNTRY' | 'GLOBAL';

interface RetrievalHeadlineScope {
  scope: HeadlineScopeKind;
  countryCode?: string; // set for COUNTRY, omitted for GLOBAL
  /** Per-scope depth. Omitted when this scope uses the request-level default,
   *  so the wire payload stays identical to today for an untouched profile. */
  limit?: number;
}

interface RetrievalProfileTopic {
  topicId: string;
  text: string;
  limit: number;
  effectiveWeight: number;
}

/** What the order ranks by. Stays on the device: never part of the output. */
interface RankedTopic extends RetrievalProfileTopic {
  factKey: string;
  createdAtMs: number;
}

export interface RetrievalProfile {
  topics: RetrievalProfileTopic[];
  headlineScopes: RetrievalHeadlineScope[];
  headlineLimitPerScope: number;
}

/** How many top headlines Mera reads per scope before deciding which matter.
 *
 *  20 is the product requirement, not a tuning choice: "By default always make
 *  sure that the top 20 articles from the top headlines in each country the
 *  user is interested in is also used to create suggestion." Shipped as 10
 *  during headlines P1-P6 and corrected here in P7.
 *
 *  Bounded above by the server, which 400s over 25
 *  (articles-for-topics.resolver.ts) — so 20 leaves headroom for a per-scope
 *  override without a stored setting being able to fail a sync.
 *
 *  Cost note: this doubles the headline articles entering scoring per sync
 *  (up to 6 scopes x 20). The ladder in the depth UI is derived from this
 *  constant, so lowering it later needs no copy or re-translation. */
export const DEFAULT_HEADLINE_LIMIT_PER_SCOPE = 20;

/** Hard ceiling on any per-scope depth. Mirrors the server's own maximum
 *  (articles-for-topics.resolver.ts), which returns a 400 above it — a feed
 *  sync must never fail because a stored setting drifted out of range. */
export const MAX_HEADLINE_DEPTH = 25;

/** The scope key used for the GLOBAL scope in `headlineDepthByScope`. Country
 *  scopes key on their uppercase country code. */
export const GLOBAL_SCOPE_KEY = 'GLOBAL';
/** Past this many distinct texts the list goes in `fairShareOrder`. Every text is
 *  still sent; feed sync batches them. */
const FAIR_ORDER_ABOVE = 200;
const MAX_COUNTRY_SCOPES = 5;

// Per-topic retrieval limit: limit = clamp(round(BASE + SPAN * wForLimit), MIN, MAX).
// At the shipped default seed weight (wEff = 0.75, MIGRATION_TOPIC_SEED_WEIGHT /
// llmTopicWeight in persona-migration.ts / config.ts) this yields exactly 40:
// round(10 + 40 * 0.75) = round(40) = 40. A high-priority topic (wForLimit =
// 0.75 * 1.4 = 1.05) clamps at TOPIC_LIMIT_MAX. TOPIC_LIMIT_MAX must stay ≤ the
// server's per-topic limitPerTopic (articles-for-topics.service.ts:356 —
// `query.topics[i].limit ?? limitPerTopic`, sent as 40 by feed-sync-steps.ts) —
// raising this above what the server allows per topic is silently truncated
// server-side, so the two must be changed together.
export const TOPIC_LIMIT_BASE = 10;
export const TOPIC_LIMIT_SPAN = 40;
export const TOPIC_LIMIT_MIN = 8;
export const TOPIC_LIMIT_MAX = 40;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

const LOCATION_ROLES_ALWAYS = new Set(['home', 'work', 'family', 'partner_family']);

/**
 * The order of a long list: heaviest first, then round by round across the facts
 * tied at that weight, so a fact's Nth topic waits for every tied fact's (N-1)th.
 * Oldest first within a fact and within a round; a merged text is as old as its
 * oldest member. Facts weigh in by weight only, so a heavier fact still fills
 * its slots first.
 */
function fairShareOrder(topics: RankedTopic[]): RankedTopic[] {
  const byAge = (a: RankedTopic, b: RankedTopic): number => {
    if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
    if (a.text !== b.text) return a.text < b.text ? -1 : 1;
    return a.topicId < b.topicId ? -1 : a.topicId > b.topicId ? 1 : 0;
  };
  const taken = new Map<string, number>();
  const round = new Map<RankedTopic, number>();
  for (const t of [...topics].sort(byAge)) {
    const key = `${t.effectiveWeight}\x00${t.factKey}`;
    const n = taken.get(key) ?? 0;
    taken.set(key, n + 1);
    round.set(t, n);
  }
  return [...topics].sort(
    (a, b) =>
      b.effectiveWeight - a.effectiveWeight ||
      (round.get(a) ?? 0) - (round.get(b) ?? 0) ||
      byAge(a, b),
  );
}

/**
 * Build the privacy-lean retrieval profile sent to the server for feed sync.
 *
 * Topics: only active topics with effectiveWeight (w_eff) > 0 are kept —
 * negatives, zero-weight, suppressed/retired topics never appear here.
 *
 * Duplicate texts collapse. One text can live on several facts ("EU AI Act
 * enforcement" on five), and the server answers per TEXT, so each extra entry
 * would only cost a request slot. Merge rule, by normalised text (lowercase, trimmed, whitespace
 * collapsed), deterministic: the representative is the member first in the
 * sort (highest effectiveWeight, then text, then topicId), so its topicId,
 * text and effectiveWeight (the max) are what is sent, which is also the id
 * feed-sync's first-writer-wins `textToTopicId` already attributed results
 * to; `limit` is the max across members. `strictMatch` is not a profile
 * field: feed-sync derives it per normalised text over ALL active topics
 * (loose wins), so a merged text carries the flag its members would have.
 *
 * There is no count cap: every text with a positive weight is returned. A long
 * list goes in `fairShareOrder`, because order decides who waits in a short sync
 * and what the daily quota clips (feed-sync's `serverArticleIds` follows it), so
 * one big fact cannot put a small one last.
 *
 * Headline scopes: one COUNTRY scope per distinct qualifying country code,
 * derived from locations with role home/work/family/partner_family (always) or
 * a non-expired role 'travel' (role 'interest' is excluded entirely). Capped
 * at 5 COUNTRY scopes, then a GLOBAL scope is always appended last.
 *
 * Scope ORDER is load-bearing, not cosmetic: the server dedups a story to the
 * FIRST scope that carries it, so putting countries before GLOBAL is what keeps
 * a big domestic story with the reader's own country and leaves GLOBAL carrying
 * what is genuinely international.
 *
 * Depth: a scope carries an explicit `limit` only when `headlineDepthByScope`
 * gives it one that differs from `headlineLimitPerScope`, so an untouched
 * profile is byte-identical to the pre-per-scope-depth payload.
 */
export function buildRetrievalProfile(input: BuildRetrievalProfileInput): RetrievalProfile {
  const nowMs = input.nowMs ?? Date.now();
  const headlineLimitPerScope = input.headlineLimitPerScope ?? DEFAULT_HEADLINE_LIMIT_PER_SCOPE;

  // --- Topics ---------------------------------------------------------
  const kept: RankedTopic[] = [];
  for (const t of input.topics) {
    const factWeight = t.factWeight ?? 1;
    const wEff = clamp(t.weight * factWeight, -1, 1);
    if (wEff <= 0) continue; // negatives / zero excluded — never sent
    const wForLimit = wEff * (t.highPriority ? 1.4 : 1);
    const limit = clamp(
      Math.round(TOPIC_LIMIT_BASE + TOPIC_LIMIT_SPAN * wForLimit),
      TOPIC_LIMIT_MIN,
      TOPIC_LIMIT_MAX,
    );
    kept.push({
      topicId: t.topicId,
      text: t.text,
      limit,
      effectiveWeight: wEff,
      factKey: t.factId ?? t.topicId,
      createdAtMs: t.createdAtMs ?? 0,
    });
  }

  kept.sort((a, b) => {
    if (b.effectiveWeight !== a.effectiveWeight) return b.effectiveWeight - a.effectiveWeight;
    if (a.text !== b.text) return a.text < b.text ? -1 : 1;
    return a.topicId < b.topicId ? -1 : a.topicId > b.topicId ? 1 : 0;
  });

  // Collapse duplicate texts (see the merge rule above).
  const byText = new Map<string, RankedTopic>();
  const distinct: RankedTopic[] = [];
  for (const t of kept) {
    const key = normalizeTopicText(t.text);
    const representative = byText.get(key);
    if (representative) {
      if (t.limit > representative.limit) representative.limit = t.limit;
      if (t.createdAtMs < representative.createdAtMs) representative.createdAtMs = t.createdAtMs;
      continue;
    }
    const entry = { ...t };
    byText.set(key, entry);
    distinct.push(entry);
  }

  const topics = (distinct.length > FAIR_ORDER_ABOVE ? fairShareOrder(distinct) : distinct).map(
    ({ topicId, text, limit, effectiveWeight }) => ({ topicId, text, limit, effectiveWeight }),
  );

  // --- Headline scopes --------------------------------------------------
  // Track the best (max) weight seen per distinct, normalized country code.
  const bestWeightByCountry = new Map<string, number>();
  for (const loc of input.locations) {
    const role = loc.role;
    const qualifies =
      LOCATION_ROLES_ALWAYS.has(role) ||
      (role === 'travel' && (loc.validUntilMs == null || loc.validUntilMs > nowMs));
    if (!qualifies) continue; // role 'interest' (and expired travel) excluded

    const code = loc.countryCode.trim().toUpperCase();
    if (!code) continue;
    const existing = bestWeightByCountry.get(code);
    if (existing === undefined || loc.weight > existing) {
      bestWeightByCountry.set(code, loc.weight);
    }
  }

  const countryCodes = Array.from(bestWeightByCountry.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .slice(0, MAX_COUNTRY_SCOPES)
    .map(([code]) => code);

  // Per-scope depth: only emitted when it actually differs from the
  // request-level default, so an untouched profile sends byte-identical input
  // to what it sent before per-scope depth existed.
  const depthMap = input.headlineDepthByScope;
  const depthFor = (scopeKey: string): number | undefined => {
    const raw = depthMap?.[scopeKey];
    if (raw == null || !Number.isFinite(raw)) return undefined;
    const clamped = clamp(Math.round(raw), 0, MAX_HEADLINE_DEPTH);
    return clamped === headlineLimitPerScope ? undefined : clamped;
  };

  const headlineScopes: RetrievalHeadlineScope[] = countryCodes.map((countryCode) => {
    const limit = depthFor(countryCode);
    return limit === undefined
      ? { scope: 'COUNTRY' as const, countryCode }
      : { scope: 'COUNTRY' as const, countryCode, limit };
  });
  const globalLimit = depthFor(GLOBAL_SCOPE_KEY);
  headlineScopes.push(
    globalLimit === undefined
      ? { scope: 'GLOBAL' }
      : { scope: 'GLOBAL', limit: globalLimit },
  );

  return {
    topics,
    headlineScopes,
    headlineLimitPerScope,
  };
}
