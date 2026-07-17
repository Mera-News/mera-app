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

export interface RetrievalTopicInput {
  topicId: string;
  text: string;
  weight: number; // topic.weight
  highPriority: boolean;
  factWeight?: number | null; // owning fact.weight; null/undefined ⇒ 1.0
}

export interface RetrievalLocationInput {
  countryCode: string;
  role: string; // 'home'|'travel'|'family'|'partner_family'|'interest'
  weight: number;
  validUntilMs?: number | null;
}

export interface BuildRetrievalProfileInput {
  topics: RetrievalTopicInput[];
  locations: RetrievalLocationInput[];
  nowMs?: number; // default Date.now()
  headlineLimitPerScope?: number; // default 10
  maxTopics?: number; // default 200
}

export type HeadlineScopeKind = 'COUNTRY' | 'GLOBAL';

export interface RetrievalHeadlineScope {
  scope: HeadlineScopeKind;
  countryCode?: string; // set for COUNTRY, omitted for GLOBAL
}

export interface RetrievalProfileTopic {
  topicId: string;
  text: string;
  limit: number;
  effectiveWeight: number;
}

export interface RetrievalProfile {
  topics: RetrievalProfileTopic[];
  headlineScopes: RetrievalHeadlineScope[];
  headlineLimitPerScope: number;
}

const DEFAULT_HEADLINE_LIMIT_PER_SCOPE = 10;
const DEFAULT_MAX_TOPICS = 200;
const MAX_COUNTRY_SCOPES = 5;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

const LOCATION_ROLES_ALWAYS = new Set(['home', 'family', 'partner_family']);

/**
 * Build the privacy-lean retrieval profile sent to the server for feed sync.
 *
 * Topics: only active topics with effectiveWeight (w_eff) > 0 are kept —
 * negatives, zero-weight, suppressed/retired topics never appear here.
 *
 * Headline scopes: one COUNTRY scope per distinct qualifying country code,
 * derived from locations with role home/family/partner_family (always) or
 * a non-expired role 'travel' (role 'interest' is excluded entirely). Capped
 * at 5 COUNTRY scopes, then a GLOBAL scope is always appended last.
 */
export function buildRetrievalProfile(input: BuildRetrievalProfileInput): RetrievalProfile {
  const nowMs = input.nowMs ?? Date.now();
  const headlineLimitPerScope = input.headlineLimitPerScope ?? DEFAULT_HEADLINE_LIMIT_PER_SCOPE;
  const maxTopics = input.maxTopics ?? DEFAULT_MAX_TOPICS;

  // --- Topics ---------------------------------------------------------
  const kept: RetrievalProfileTopic[] = [];
  for (const t of input.topics) {
    const factWeight = t.factWeight ?? 1;
    const wEff = clamp(t.weight * factWeight, -1, 1);
    if (wEff <= 0) continue; // negatives / zero excluded — never sent
    const wForLimit = wEff * (t.highPriority ? 1.4 : 1);
    const limit = clamp(Math.round(6 + 18 * wForLimit), 4, 24);
    kept.push({
      topicId: t.topicId,
      text: t.text,
      limit,
      effectiveWeight: wEff,
    });
  }

  kept.sort((a, b) => {
    if (b.effectiveWeight !== a.effectiveWeight) return b.effectiveWeight - a.effectiveWeight;
    return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
  });

  const topics = kept.slice(0, maxTopics);

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

  const headlineScopes: RetrievalHeadlineScope[] = countryCodes.map((countryCode) => ({
    scope: 'COUNTRY' as const,
    countryCode,
  }));
  headlineScopes.push({ scope: 'GLOBAL' });

  return {
    topics,
    headlineScopes,
    headlineLimitPerScope,
  };
}
