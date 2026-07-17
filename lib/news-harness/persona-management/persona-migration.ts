// news-harness — pure persona-v3 silent-migration planner (RN-free).
//
// Wave 6 (M-P2): converts the legacy persona (facts + `fact.metadata.topics`
// string lists) into the structured v3 plan the RN runner
// (lib/services/persona-migration-service.ts) writes to WatermelonDB:
//   - one `topics` row per metadata topic string (seed weight 0.75,
//     provenance 'migration', status 'active');
//   - fact.weight = 1.0 for every migrated fact;
//   - DETERMINISTIC-ONLY location candidates parsed from location-anchored
//     fact statements (the LLM refinement pass is a later wave);
//   - one change-log entry per fact (source 'migration').
//
// `fact.metadata.topics` is NEVER modified — the plan only reads it.
//
// Location anchoring convention (see prompts.ts LOCATION ANCHORING): personal/
// local facts carry a comma-chained place hierarchy expanded to
// neighborhood → city → country → continent/bloc, e.g.
//   "Lives in Nieuw-West, Amsterdam, Netherlands, Europe"
//   "Parents live in Brooklyn, New York, United States, North America"
// Global/professional interests are never anchored (and carry no comma chain),
// so chain detection doubles as the anchored-fact detector.

/** Seed topic weight — M-P2 delta: 0.75 (0.6 landed below the FEED floor). */
export const MIGRATION_TOPIC_SEED_WEIGHT = 0.75;

/** Every migrated fact gets an explicit weight of 1.0. */
export const MIGRATION_FACT_WEIGHT = 1.0;

// ── Input / output shapes (plain data; no DB, no RN) ─────────────────────

export interface FactSnapshot {
  id: string;
  statement: string;
  /** `fact.metadata.topics` — read-only input, never mutated. */
  topics: string[];
  questionnaireAttribute?: string | null;
}

export interface MigrationTopicRow {
  factId: string;
  text: string;
  normalizedText: string;
  weight: number;
  status: 'active';
  provenance: 'migration';
  highPriority: false;
}

export type MigrationLocationRole =
  | 'home'
  | 'travel'
  | 'family'
  | 'partner_family'
  | 'interest';

export interface MigrationLocationCandidate {
  sourceFactId: string;
  city: string | null;
  region: string | null;
  countryCode: string;
  role: MigrationLocationRole;
  weight: number;
  validUntil: null;
}

export interface MigrationChangeLogEntry {
  actionType: 'migrate_fact';
  action: {
    targetId: string;
    before: { weight: null };
    after: { weight: number };
    topicsCreated: number;
    locationsDerived: number;
  };
  source: 'migration';
  summary: string;
}

export interface PersonaMigrationPlan {
  topicRows: MigrationTopicRow[];
  factWeightUpdates: { factId: string; weight: number }[];
  locationCandidates: MigrationLocationCandidate[];
  changeLogEntries: MigrationChangeLogEntry[];
}

// ── Normalization ────────────────────────────────────────────────────────

/** Lowercase + trim + collapse whitespace — mirror of topic-service's key. */
export function normalizeTopicText(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

// ── Deterministic location parsing ───────────────────────────────────────

/** Continent / bloc names that terminate an anchored chain (stripped). */
const CONTINENT_NAMES = new Set([
  'europe',
  'european union',
  'eu',
  'north america',
  'south america',
  'latin america',
  'central america',
  'asia',
  'southeast asia',
  'africa',
  'oceania',
  'australia',
  'antarctica',
  'middle east',
]);

/** Common country name → ISO-3166-1 alpha-2. Deterministic-only wave: chains
 *  whose country doesn't resolve here are skipped (the LLM refinement pass in
 *  a later wave picks them up). */
const COUNTRY_CODES: Record<string, string> = {
  'netherlands': 'NL', 'the netherlands': 'NL', 'holland': 'NL',
  'germany': 'DE', 'france': 'FR', 'spain': 'ES', 'portugal': 'PT',
  'italy': 'IT', 'belgium': 'BE', 'austria': 'AT', 'switzerland': 'CH',
  'united kingdom': 'GB', 'uk': 'GB', 'great britain': 'GB', 'england': 'GB',
  'scotland': 'GB', 'wales': 'GB', 'northern ireland': 'GB', 'ireland': 'IE',
  'poland': 'PL', 'ukraine': 'UA', 'russia': 'RU', 'czech republic': 'CZ',
  'czechia': 'CZ', 'slovakia': 'SK', 'hungary': 'HU', 'romania': 'RO',
  'bulgaria': 'BG', 'greece': 'GR', 'turkey': 'TR', 'türkiye': 'TR',
  'sweden': 'SE', 'norway': 'NO', 'denmark': 'DK', 'finland': 'FI',
  'iceland': 'IS', 'estonia': 'EE', 'latvia': 'LV', 'lithuania': 'LT',
  'croatia': 'HR', 'serbia': 'RS', 'slovenia': 'SI', 'luxembourg': 'LU',
  'united states': 'US', 'usa': 'US', 'us': 'US', 'america': 'US',
  'united states of america': 'US',
  'canada': 'CA', 'mexico': 'MX', 'brazil': 'BR', 'argentina': 'AR',
  'chile': 'CL', 'colombia': 'CO', 'peru': 'PE', 'uruguay': 'UY',
  'india': 'IN', 'china': 'CN', 'japan': 'JP', 'south korea': 'KR',
  'korea': 'KR', 'indonesia': 'ID', 'thailand': 'TH', 'vietnam': 'VN',
  'philippines': 'PH', 'malaysia': 'MY', 'singapore': 'SG', 'taiwan': 'TW',
  'hong kong': 'HK', 'pakistan': 'PK', 'bangladesh': 'BD', 'sri lanka': 'LK',
  'nepal': 'NP', 'israel': 'IL', 'saudi arabia': 'SA',
  'united arab emirates': 'AE', 'uae': 'AE', 'qatar': 'QA', 'kuwait': 'KW',
  'jordan': 'JO', 'lebanon': 'LB', 'iran': 'IR', 'iraq': 'IQ',
  'egypt': 'EG', 'nigeria': 'NG', 'south africa': 'ZA', 'kenya': 'KE',
  'ethiopia': 'ET', 'ghana': 'GH', 'morocco': 'MA', 'tunisia': 'TN',
  'algeria': 'DZ', 'tanzania': 'TZ', 'uganda': 'UG',
  'australia': 'AU', 'new zealand': 'NZ',
};

/** Seed location weights per inferred role (migration defaults; user-tunable
 *  later). Home anchors the persona; interest is weakest. */
export const MIGRATION_ROLE_WEIGHTS: Record<MigrationLocationRole, number> = {
  home: 1.0,
  family: 0.7,
  partner_family: 0.6,
  travel: 0.6,
  interest: 0.4,
};

function normalizePlace(s: string): string {
  // Strip trailing punctuation and parentheticals like "Europe (EU)".
  return s.replace(/\([^)]*\)/g, '').replace(/[.!?]+$/g, '').trim().replace(/\s+/g, ' ');
}

function isContinent(segment: string): boolean {
  return CONTINENT_NAMES.has(normalizePlace(segment).toLowerCase());
}

function resolveCountryCode(segment: string): string | null {
  return COUNTRY_CODES[normalizePlace(segment).toLowerCase()] ?? null;
}

/**
 * Role inference from the fact statement. Order matters: partner-family
 * keywords ("girlfriend's parents") must win over plain family ("parents"),
 * and family ("parents live in") must win over home ("lives in").
 */
export function inferLocationRole(statement: string): MigrationLocationRole {
  const s = statement.toLowerCase();
  if (/(girlfriend|boyfriend|partner|in-law)/.test(s)) return 'partner_family';
  if (/(parent|family|mother|father|\bmom\b|\bdad\b|brother|sister|grand)/.test(s)) return 'family';
  if (/(travell|traveling|\btravel\b|\btrip\b|visit|vacation|holiday)/.test(s)) return 'travel';
  if (/\blives?\s+(in|at|near)\b|\bliving\s+(in|at|near)\b|\bmoved\s+to\b|\bresides?\b|\bbased\s+in\b|\bhome\s+in\b/.test(s)) {
    return 'home';
  }
  return 'interest';
}

/**
 * Parses a location-anchored statement into a location candidate, or null
 * when the statement carries no recognizable comma-chained place hierarchy.
 *
 * Heuristics (deterministic-only this wave):
 *  1. Split on commas; a chain needs ≥2 segments (unanchored facts have none).
 *  2. The first segment usually embeds the anchor phrase — keep only the text
 *     after its last place-preposition ("Lives in Nieuw-West" → "Nieuw-West").
 *     If it has no preposition, the first segment is not part of the chain.
 *  3. Strip a trailing continent/bloc segment when present.
 *  4. The (new) last segment must resolve to a known country → country_code;
 *     otherwise the statement is skipped.
 *  5. Remaining segments: city = first (most specific place, e.g. Chhindwara
 *     in "Chhindwara, Madhya Pradesh, India"), region = last of the rest.
 *     Neighborhood-vs-city ambiguity ("Nieuw-West, Amsterdam") is accepted —
 *     the city ends up one level too specific and the true city lands in
 *     `region` (still a REGION-level geo match); the LLM pass refines later.
 */
export function parseLocationFromStatement(
  statement: string,
): Omit<MigrationLocationCandidate, 'sourceFactId' | 'role' | 'weight' | 'validUntil'> | null {
  const segments = statement.split(',').map((s) => normalizePlace(s)).filter(Boolean);
  if (segments.length < 2) return null;

  // Extract the first place from the anchor phrase in segment[0].
  const anchorMatch = segments[0].match(/^(?:.*\b(?:in|at|to|near|from|of)\b\s+)(.+)$/i);
  const chain: string[] = [];
  if (anchorMatch) {
    chain.push(normalizePlace(anchorMatch[1]));
  }
  chain.push(...segments.slice(1));
  if (chain.length < 2) return null;

  // Strip trailing continent/bloc.
  if (isContinent(chain[chain.length - 1])) chain.pop();
  if (chain.length === 0) return null;

  const countryCode = resolveCountryCode(chain[chain.length - 1]);
  if (!countryCode) return null;
  chain.pop();

  const city = chain.length > 0 ? chain[0] : null;
  const region = chain.length > 1 ? chain[chain.length - 1] : null;
  return { city, region, countryCode };
}

// ── Plan builder ─────────────────────────────────────────────────────────

/**
 * Builds the full write plan for a set of facts that have NOT yet been
 * migrated (the runner pre-filters). Pure and deterministic:
 *  - topic rows deduped per fact on normalized text;
 *  - location candidates deduped across facts on (city, country, role);
 *  - one change-log entry per fact.
 */
export function buildPersonaMigrationPlan(facts: FactSnapshot[]): PersonaMigrationPlan {
  const topicRows: MigrationTopicRow[] = [];
  const factWeightUpdates: PersonaMigrationPlan['factWeightUpdates'] = [];
  const locationCandidates: MigrationLocationCandidate[] = [];
  const changeLogEntries: MigrationChangeLogEntry[] = [];
  const seenLocationKeys = new Set<string>();

  for (const fact of facts) {
    // 1. Topics: one row per metadata topic string, deduped per fact.
    const seenTopicKeys = new Set<string>();
    let topicsCreated = 0;
    for (const raw of fact.topics) {
      const text = (raw ?? '').trim();
      if (!text) continue;
      const normalizedText = normalizeTopicText(text);
      if (seenTopicKeys.has(normalizedText)) continue;
      seenTopicKeys.add(normalizedText);
      topicRows.push({
        factId: fact.id,
        text,
        normalizedText,
        weight: MIGRATION_TOPIC_SEED_WEIGHT,
        status: 'active',
        provenance: 'migration',
        highPriority: false,
      });
      topicsCreated += 1;
    }

    // 2. Fact weight.
    factWeightUpdates.push({ factId: fact.id, weight: MIGRATION_FACT_WEIGHT });

    // 3. Deterministic location derivation.
    let locationsDerived = 0;
    const parsed = parseLocationFromStatement(fact.statement);
    if (parsed) {
      const role = inferLocationRole(fact.statement);
      const key = `${(parsed.city ?? '').toLowerCase()}|${parsed.countryCode}|${role}`;
      if (!seenLocationKeys.has(key)) {
        seenLocationKeys.add(key);
        locationCandidates.push({
          sourceFactId: fact.id,
          city: parsed.city,
          region: parsed.region,
          countryCode: parsed.countryCode,
          role,
          weight: MIGRATION_ROLE_WEIGHTS[role],
          validUntil: null,
        });
        locationsDerived += 1;
      }
    }

    // 4. Audit trail.
    changeLogEntries.push({
      actionType: 'migrate_fact',
      action: {
        targetId: fact.id,
        before: { weight: null },
        after: { weight: MIGRATION_FACT_WEIGHT },
        topicsCreated,
        locationsDerived,
      },
      source: 'migration',
      summary: `Migrated fact to persona v3 (${topicsCreated} topics${locationsDerived > 0 ? ', 1 location' : ''}): ${fact.statement.slice(0, 80)}`,
    });
  }

  return { topicRows, factWeightUpdates, locationCandidates, changeLogEntries };
}
