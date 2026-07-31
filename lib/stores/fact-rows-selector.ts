// fact-rows-selector — the pure selector behind the Round-3 fact-rows For-You
// view. Turns the render-gated suggestion pool into per-fact horizontal rows
// (one row per owning fact) plus the breaking strip pinned above them.
//
// PURE: RN-free. It consumes the store's `ForYouSuggestion` rows + the persona
// snapshots and returns plain data the screen renders verbatim; no DB / expo /
// react-native imports, so it unit-tests without a device.
//
// Pipeline (mirrors the proven Wave-7 selector, minus the sectioned/two-zone
// machinery): filter to visible → story-group → pick a representative per group
// → pull breaking out → assign each remaining group to a fact section via
// `resolveOwningFactLenient` (a story folds into the fact it matched even at
// zero signal, so low-priority suggestions live inside their fact section; a
// negative/suppressed or factless match resolves to null and is DROPPED — there
// is no "Also for you" catch-all) → order cards newest-first within a row and
// rows by their newest "added" time.
//
// HEADLINE SECTIONS (P5): top-headline rows carry a persisted `headline_scope`
// and SYNTHETIC matched topics (`topicId: null`), so ownership can never resolve
// an owner for them and a single `if (!factId) continue` silently dropped every
// one of them from the Dashboard — while the Feed tab rendered them all along.
// They now fall through to a section per scope (one per COUNTRY code, one
// GLOBAL) that sits ALONGSIDE the fact sections and clears the SAME relevance
// bar. Each carries a `headlineReadCount` denominator so the section can state,
// in one line, how many headlines Mera read for the scope versus how many it
// judged worth the reader's time.
//
// A section with ZERO surviving cards is DROPPED (P9), exactly like a fact
// section — see step 5b. This reverses P5, which kept the empty shell so its
// denominator could say "Mera read 20 · none looked relevant today"; the user
// overruled that, since an empty section promises content and then admits it has
// none. The `…DenominatorNone` strings still exist in all 20 locales as an
// unreachable guard — do not read their presence as evidence the state occurs.
//
// Section membership additionally requires the fact link to be RELEVANCE-BACKED
// (`isSectionMemberEligible` + `isFactSectionViable`, feed-select/ownership).
// Ownership alone answers "which fact did this story MATCH?" from topic weights
// and never looks at what the scorer concluded about the article, so a coarse
// vector-search hit that was then scored to near-zero still claimed a section —
// producing a "News about: Learning Dutch" section of EU-AI-labelling stories,
// one of which rendered Mera's own "no direct tie to your Dutch learning"
// rationale inside the section claiming it.
//
// Visibility rule (user-specified, Round-3 C1): a card enters its row once its
// NOTE exists — i.e. the row reached `complete` (terminal: note text present OR
// deliberately skipped for a sub-threshold-reason row). `reason_pending` rows
// (scored, note still generating) stay hidden; the status accordion narrates the
// wait. Sub-render-gate (≤ 0.3) and out-of-window rows never render.

import {
  bucketOf,
  bucketRank,
  isSectionMemberEligible,
  isFactSectionViable,
  resolveOwningFactLenient,
  countryHeadlineSectionId,
  headlineSectionWeight,
  isHeadlineSectionId,
  GLOBAL_HEADLINE_SECTION_ID,
  type FeedBucket,
  type ScoredSuggestionProjection,
  type TopicSnapshot,
  type FactSnapshot,
  type LocationSnapshot,
} from '@/lib/news-harness/feed-select';
import {
  buildStoryGroups,
  pickRepresentative,
  TITLE_JACCARD_DISPLAY_THRESHOLD,
  CLUSTER_CORE_CONFIDENCE_THRESHOLD,
  WEIGHTED_JACCARD_DISPLAY_THRESHOLD,
  ENTITY_JACCARD_DISPLAY_THRESHOLD,
  SCORE_PROPAGATION_LOOKBACK_MS,
  type GroupableItem,
} from '@/lib/feed-grouping/story-grouping';
import { DEFAULT_HARNESS_CONFIG, type HarnessConfig } from '@/lib/news-harness/core/config';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import {
  repPriorityTier,
  sourcePriorityTier,
  type UserGeoLanguageContext,
} from '@/lib/feed-grouping/geo-language-priority';
import type { ForYouSuggestion } from './for-you-store';

/**
 * Publication window for everything the user can see — the Feed tab, the
 * Dashboard, and the swipe stack all gate on this one constant.
 *
 * 48h, and deliberately not a second hardcoded copy: it IS
 * `SCORE_PROPAGATION_LOOKBACK_MS`, which is also what the header sentence
 * counts over (see lib/hooks/use-feed-counts.ts) and what the storage TTL keeps
 * (`SUGGESTION_TTL_MS` in lib/scheduler/tasks/data-cleanup-task.ts). Binding
 * them together is the point: this was 24h while the header counted 48h, so the
 * header advertised a pile of articles the feed then silently refused to render,
 * and there was no way to tell that apart from a bug.
 *
 * Widening it also simply gives the user more to read — rows in the 24-48h band
 * were already on the device, already scored, and already being kept alive as
 * score-propagation donors; they were just never shown.
 */
export const FEED_WINDOW_MS = SCORE_PROPAGATION_LOOKBACK_MS;

/** The render gate — a scored row must clear this to be shown. Exported so the
 *  swipe-stack selector reuses the exact same threshold. */
export const RENDER_GATE = 0.3;

const BREAKING_EVENT_TYPES = new Set(['disaster', 'weather', 'conflict']);

/** One breaking-strip entry (representative + collapsed members). Consumed by
 *  `BreakingStrip`. */
export interface BreakingCardData {
  data: ForYouSuggestion;
  members: ForYouSuggestion[];
}

/** One story-group card in a fact row (a collapsed multi-source story). */
export interface FactRowGroup {
  /** The fronting suggestion (newest member of the story). */
  data: ForYouSuggestion;
  /** The other collapsed members (group minus representative), input order. */
  members: ForYouSuggestion[];
  rawScore: number | null;
  bucket: FeedBucket;
  /** Newest member's pubDate (epoch ms) — the story's display timestamp. */
  pubDateMs: number;
  /** Newest member's `scoredAt ?? createdAt` (epoch ms) — the "added" time. */
  addedMs: number;
  /** Representative's `createdAt` (epoch ms) — the suggestion-creation time that
   *  orders cards within a Dashboard section (newest-created first). */
  createdAtMs: number;
  /** True when this group is high-priority: its display bucket is HIGH (or above)
   *  OR one of the representative's matched topics is flagged `highPriority` in
   *  the persona snapshots. Drives section ordering + the unread-HP-first rule. */
  highPriority: boolean;
}

/**
 * What a Dashboard section IS.
 *  - `fact`             — a persona fact's own section ("News about: X").
 *  - `headline-country` — top headlines for one country scope.
 *  - `headline-global`  — top headlines for the GLOBAL scope.
 *
 * `FactRow.kind` is OPTIONAL and absent ⇒ `'fact'`: every section was a fact
 * section before headline sections existed, so callers (and fixtures) that build
 * `FactRow` literals without it keep compiling and keep meaning what they meant.
 * Read it through {@link sectionKindOf}, never directly.
 */
export type SectionKind = 'fact' | 'headline-country' | 'headline-global';

/** The section's kind, defaulting an absent `kind` to `'fact'`. */
export function sectionKindOf(row: Pick<FactRow, 'kind'>): SectionKind {
  return row.kind ?? 'fact';
}

/** True for the two headline section kinds. */
export function isHeadlineRow(row: Pick<FactRow, 'kind'>): boolean {
  return sectionKindOf(row) !== 'fact';
}

export { isHeadlineSectionId };

/** One fact row: a fact's stories laid out as a horizontal strip. */
export interface FactRow {
  /** The section id. For a fact section this is the owning fact's id; for a
   *  headline section it is the synthetic scope id minted by
   *  `countryHeadlineSectionId` / `GLOBAL_HEADLINE_SECTION_ID`. Named `factId`
   *  (not `sectionId`) because it IS the fact id in the overwhelmingly common
   *  case and renaming it would churn every consumer for no behaviour. */
  factId: string;
  /** See {@link SectionKind}. Absent ⇒ `'fact'`. */
  kind?: SectionKind;
  /** ISO alpha-2 country of a `headline-country` section; null/absent on every
   *  other kind. The UI turns it into the display country name. */
  countryCode?: string | null;
  /** HEADLINE SECTIONS ONLY — how many headline suggestions for this scope are
   *  in the local publication window, whether or not they cleared the relevance
   *  bar. The denominator of the section's one-line
   *  "Mera read N · M worth your time". Counted over RAW suggestions (what the
   *  server actually sent for the scope), while `groups.length` is the numerator
   *  (what actually renders) — deliberately different units, because the
   *  sentence's claim is "of everything Mera read, this much was worth it". */
  headlineReadCount?: number;
  /** Section-ordering pseudo-weight, one axis shared by both kinds: a fact
   *  section uses the fact's own `weight` (null ⇒ 1.0), a headline section uses
   *  {@link headlineSectionWeight}. Absent ⇒ 1.0. */
  weight?: number;
  /** Display title (the fact's section title). EMPTY for headline sections: a
   *  headline section's title is a LOCALIZED string, not user data, so it is
   *  derived in the UI layer from `kind` + `countryCode` instead of being baked
   *  into this RN-free selector. */
  statement: string;
  /** The underlying real fact statement (header reveal). */
  factStatement: string | null;
  /** Newest `addedMs` across the row's groups. KEPT for other consumers even
   *  though the Dashboard resort no longer keys on it. */
  latestAddedMs: number;
  /** Number of groups whose representative is NOT in the opened set — drives the
   *  section-header unread badge AND the Dashboard section-order sort (unread
   *  count desc). */
  unreadCount: number;
  groups: FactRowGroup[];
}

export interface FactRowsResult {
  breaking: BreakingCardData[];
  rows: FactRow[];
}

export interface FactRowsSnapshots {
  topics: Map<string, TopicSnapshot>;
  facts: Map<string, FactSnapshot>;
  locations: Map<string, LocationSnapshot>;
  /** factId → real fact statement (for the header reveal). */
  factStatements: Map<string, string>;
}

// --- helpers --------------------------------------------------------------

function parseMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Terminal note-gate: the note exists, or was deliberately skipped. */
export function isComplete(s: ForYouSuggestion): boolean {
  return s.status === ArticleSuggestionStatus.Complete;
}

/** The render gate — strictly above `RENDER_GATE`. */
export function passesRenderGate(s: ForYouSuggestion): boolean {
  return (s.relevance ?? 0) > RENDER_GATE;
}

/** The publication window (`cutoffMs = nowMs - FEED_WINDOW_MS`, 48h). */
export function isWithinWindow(s: ForYouSuggestion, cutoffMs: number): boolean {
  return parseMs(s.firstPubDate) >= cutoffMs;
}

/** A row is VISIBLE once its note exists (status `complete`) — see the module
 *  header. Must also clear the render gate and the publication window (see
 *  FEED_WINDOW_MS). Exported so the
 *  swipe-stack selector applies the identical visibility gate.
 *
 *  Composed from the three named sub-predicates above so the funnel diagnostic
 *  can attribute WHICH gate rejected a row without re-implementing (and then
 *  drifting from) the comparisons. Keep the conjunction order in sync with the
 *  diagnostic's attribution order. */
export function isVisible(s: ForYouSuggestion, cutoffMs: number): boolean {
  return isComplete(s) && passesRenderGate(s) && isWithinWindow(s, cutoffMs);
}

/** scoredAt ?? createdAt in epoch ms — the row's "added to feed" time. */
function addedMsOf(s: ForYouSuggestion): number {
  if (typeof s.scoredAt === 'number' && Number.isFinite(s.scoredAt)) return s.scoredAt;
  return parseMs(s.createdAt);
}

/** Breaking predicate (rawScore > 1.0, or ≥ 0.8 with a disaster/weather/conflict
 *  event type). Exported so the swipe-stack selector's deck ordering pins the
 *  same breaking stories first without duplicating the rule. */
export function isBreaking(s: ForYouSuggestion): boolean {
  const raw = s.rawScore;
  if (raw == null) return false;
  if (raw > 1.0) return true;
  return raw >= 0.8 && s.eventType != null && BREAKING_EVENT_TYPES.has(s.eventType);
}

/** Minimal ownership projection from a store row. `matchedTopics` is what
 *  `resolveOwningFactLenient` reads; the headline scope/country ride along so the
 *  headline-section routing below reads ONE projection rather than reaching back
 *  into the store row shape. */
function ownershipProjection(s: ForYouSuggestion): ScoredSuggestionProjection {
  return {
    id: s._id,
    rawScore: s.rawScore,
    relevance: s.relevance,
    pubDateMs: parseMs(s.firstPubDate),
    clusterMemberships: [],
    headlineScope: s.headlineScope ?? null,
    headlineCountryCode: normalizeCountryCode(s.headlineCountryCode),
    matchedTopics: (s.matchedTopics ?? []).map((m) => ({ topicId: m.topicId, text: m.text })),
  };
}

/** Uppercase, trimmed ISO alpha-2, or null for absent/blank. Both sides of the
 *  country key (`locations.country_code` via `buildRetrievalProfile`, and the
 *  persisted `headline_country_code`) are already normalized this way; doing it
 *  again here means a legacy or hand-built row can never split one country into
 *  two sections. */
function normalizeCountryCode(code: string | null | undefined): string | null {
  const c = (code ?? '').trim().toUpperCase();
  return c.length > 0 ? c : null;
}

/**
 * The headline section a row belongs to, or null when it has none:
 *  - not a headline row at all, or
 *  - `CITY` scope (never requested as its own retrieval scope — see
 *    `HeadlineSectionScope`), or
 *  - `COUNTRY` scope with no country code. Dropping these is deliberate: the
 *    brief's rule is that a null-country COUNTRY row belongs to no country
 *    section rather than to an invented "unknown country" bucket.
 */
function headlineSectionIdOf(rep: ScoredSuggestionProjection): string | null {
  if (rep.headlineScope === 'GLOBAL') return GLOBAL_HEADLINE_SECTION_ID;
  if (rep.headlineScope !== 'COUNTRY') return null;
  const cc = normalizeCountryCode(rep.headlineCountryCode);
  return cc ? countryHeadlineSectionId(cc) : null;
}

/** Strongest weight among the user's locations in `countryCode`, or null when
 *  the persona has none there (the scope can outlive a deleted location). */
function countryLocationWeight(
  locations: Map<string, LocationSnapshot>,
  countryCode: string,
): number | null {
  let best: number | null = null;
  for (const loc of locations.values()) {
    if (normalizeCountryCode(loc.countryCode) !== countryCode) continue;
    if (best == null || loc.weight > best) best = loc.weight;
  }
  return best;
}

interface GroupItem extends GroupableItem {
  s: ForYouSuggestion;
}

/** Representative comparator: newest pubDate → higher rawScore → smaller id.
 *  (Standard sort order: negative ⇒ `a` preferred.) */
function repCompare(a: GroupItem, b: GroupItem): number {
  const pa = parseMs(a.s.firstPubDate);
  const pb = parseMs(b.s.firstPubDate);
  if (pa !== pb) return pb - pa;
  const ra = a.s.rawScore ?? Number.NEGATIVE_INFINITY;
  const rb = b.s.rawScore ?? Number.NEGATIVE_INFINITY;
  if (ra !== rb) return rb - ra;
  return a.s._id < b.s._id ? -1 : a.s._id > b.s._id ? 1 : 0;
}

/** Tier-aware representative comparator, in three keys — kept BYTE-IDENTICAL to
 *  `feed-list-selector.makeRepCompare` so every feed surface fronts the same
 *  article for a given story:
 *
 *   1. `sourcePriorityTier` — the user's EXPLICIT source preferences (preferred
 *      publication → preferred country scope → rest). An explicit request
 *      outranks a derived signal, so it is compared FIRST.
 *   2. `repPriorityTier` — the derived geo/language priority.
 *   3. `repCompare` — newest → rawScore → id.
 *
 *  A `null` `userCtx` collapses every item to source tier 2 and geo tier 3, so
 *  this is byte-identical to `repCompare` alone — the pre-priority legacy
 *  behavior. So does a context with no source preferences, for key 1.
 *
 *  ASYMMETRY WITH THE FEED (deliberate): `feed-list-selector` also applies D4,
 *  scoring a story group on its BEST member so electing a preferred source
 *  cannot demote the story. There is no mirror here, because Dashboard card
 *  order is `cardCompare` = representative `createdAtMs` desc — there is no
 *  score to group-max. The analogous latent demotion therefore still exists on
 *  the Dashboard (a preferred rep with an older `createdAt` sinks its card);
 *  fixing it means group-maxing `createdAtMs`, a different semantic change that
 *  was not in this wave's scope. Logged as a power-user follow-up. */
function makeRepCompare(userCtx: UserGeoLanguageContext | null) {
  return (a: GroupItem, b: GroupItem): number => {
    const sa = sourcePriorityTier(
      { publicationName: a.s.publication_name, countryCodeAlpha3: a.s.country_code },
      userCtx,
    );
    const sb = sourcePriorityTier(
      { publicationName: b.s.publication_name, countryCodeAlpha3: b.s.country_code },
      userCtx,
    );
    if (sa !== sb) return sa - sb;
    const ta = repPriorityTier({ countryCodeAlpha3: a.s.country_code, languageCode: a.s.language_code }, userCtx);
    const tb = repPriorityTier({ countryCodeAlpha3: b.s.country_code, languageCode: b.s.language_code }, userCtx);
    if (ta !== tb) return ta - tb;
    return repCompare(a, b);
  };
}

/** Card (story-group) ordering within a Dashboard section: representative
 *  `createdAt` (suggestion-creation time) descending, then id. */
function cardCompare(a: FactRowGroup, b: FactRowGroup): number {
  if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs;
  return a.data._id < b.data._id ? -1 : a.data._id > b.data._id ? 1 : 0;
}

// --- public API -----------------------------------------------------------

/**
 * Build the fact-rows feed from the store rows + persona snapshots.
 *
 * @param suggestions the live `ForYouSuggestion` pool.
 * @param snapshots   topics/facts/locations + factStatements (from
 *                    `loadSectionSnapshots`).
 * @param openedIds   the opened-stories set — used to compute per-section unread
 *                    counts + the unread-high-priority-first sort. Pass the live
 *                    set so the Dashboard resorts as stories are opened.
 * @param nowMs       injected clock (deterministic testing).
 * @param userCtx     the user's geo/language context (home/other countries +
 *                    app language) — makes representative ELECTION tier-aware
 *                    (see `makeRepCompare`). `null` (default) preserves the
 *                    legacy geo/language-blind pick. Card order, breaking
 *                    sort, and section sort are unaffected.
 */
export function buildFactRows(
  suggestions: ForYouSuggestion[],
  snapshots: FactRowsSnapshots,
  openedIds: Set<string> = new Set(),
  nowMs: number = Date.now(),
  config: HarnessConfig = DEFAULT_HARNESS_CONFIG,
  userCtx: UserGeoLanguageContext | null = null,
): FactRowsResult {
  const cutoffMs = nowMs - FEED_WINDOW_MS;
  const hpMult = config.scoringEngine.HP_MULT;
  const repCompareForGroups = makeRepCompare(userCtx);

  // 0. Headline DENOMINATORS — "how many headlines did Mera read for this
  //    scope". Counted over the RAW pool inside the publication window, with no
  //    visibility/relevance gate: the sentence's whole point is to account for
  //    the headlines that did NOT make the cut, so gating it on the same bar it
  //    reports against would make it always read "N read · N worth your time".
  //    Presence of a scope here is also what makes its section EXIST — a scope
  //    with zero headlines in the window gets no section at all (there is
  //    nothing to account for), while a scope with headlines gets its section
  //    even if none of them clear the bar.
  //
  //    CO-MATCHED headlines are excluded. A headline that ALSO matched a real
  //    persona topic carries a real topicId, resolves an owning fact at step 4,
  //    and is routed to that FACT's section — never to a headline section. It
  //    was still being counted here, so the sentence described a population the
  //    section could not show. The denominator now counts only rows that could
  //    actually land in this section, using the SAME ownership resolver step 4
  //    routes with, so the two cannot disagree. Placement is deliberately
  //    unchanged: a headline about something you care about stays under that
  //    topic, which is the more personal result and the existing behaviour.
  //
  //    Known approximation: this is a per-ROW test, whereas step 4 routes per
  //    story-GROUP representative. A headline that ends up a non-rep member of a
  //    mixed group can therefore still be counted. Counting per row is inherent
  //    to a denominator computed over the raw (partly unscored, ungrouped) pool.
  const headlineReadCounts = new Map<string, number>();
  const headlineCountries = new Map<string, string>(); // sectionId → alpha-2
  for (const s of suggestions) {
    if (!isWithinWindow(s, cutoffMs)) continue;
    const projection = ownershipProjection(s);
    const sectionId = headlineSectionIdOf(projection);
    if (!sectionId) continue;
    // Owned by a fact ⇒ routed to that fact's section, not here. The resolver
    // returns null exactly when step 4 would fall through to the headline
    // section — every matched fact NEGATIVE (suppressed), or no active
    // fact-linked topic at all (the pure-headline case, synthetic topicId
    // null). Those stay counted, which is right: they are the rows this
    // section is accounting for.
    if (resolveOwningFactLenient(projection, snapshots.topics, snapshots.facts, hpMult)) {
      continue;
    }
    headlineReadCounts.set(sectionId, (headlineReadCounts.get(sectionId) ?? 0) + 1);
    const cc = normalizeCountryCode(s.headlineCountryCode);
    if (cc) headlineCountries.set(sectionId, cc);
  }

  // 1. Visible pool (note-gated + render gate + FEED_WINDOW_MS).
  const visible = suggestions.filter((s) => isVisible(s, cutoffMs));
  if (visible.length === 0) return { breaking: [], rows: [] };

  // 2. Story-group the visible pool (display thresholds incl. the weighted edge).
  const items: GroupItem[] = visible.map((s) => ({
    id: s._id,
    title: s.title_en ?? s.title_original ?? null,
    clusters: s.clusters,
    entities: s.entities,
    eventType: s.eventType,
    s,
  }));
  // `entityJaccardThreshold` enables the entity-overlap edge — DISPLAY-only by
  // design (score-propagation deliberately omits it; see PROPAGATION_OPTIONS).
  const groups = buildStoryGroups(items, {
    titleJaccardThreshold: TITLE_JACCARD_DISPLAY_THRESHOLD,
    clusterConfidenceThreshold: CLUSTER_CORE_CONFIDENCE_THRESHOLD,
    weightedJaccardThreshold: WEIGHTED_JACCARD_DISPLAY_THRESHOLD,
    entityJaccardThreshold: ENTITY_JACCARD_DISPLAY_THRESHOLD,
  });

  // 3. Per group: pick a representative (newest member) + collapse members.
  const breaking: BreakingCardData[] = [];
  const assignable: { rep: ForYouSuggestion; group: FactRowGroup }[] = [];

  for (const g of groups) {
    const rep = pickRepresentative(g, repCompareForGroups).s;
    const members = g.map((it) => it.s).filter((m) => m._id !== rep._id);
    const all = [rep, ...members];
    const pubDateMs = all.reduce((mx, m) => Math.max(mx, parseMs(m.firstPubDate)), 0);
    const addedMs = all.reduce((mx, m) => Math.max(mx, addedMsOf(m)), 0);

    if (isBreaking(rep)) {
      breaking.push({ data: rep, members });
      continue;
    }
    const bucket = bucketOf(rep.relevance, config);
    // High-priority: display bucket HIGH+ OR a matched persona topic flagged
    // highPriority. (bucketRank ≥ HIGH also captures the EMERGENCY tier, which
    // is strictly higher-priority than HIGH.)
    const highPriority =
      bucketRank(bucket) >= bucketRank('HIGH') ||
      (rep.matchedTopics ?? []).some(
        (m) => m.topicId != null && snapshots.topics.get(m.topicId)?.highPriority === true,
      );
    assignable.push({
      rep,
      group: {
        data: rep,
        members,
        rawScore: rep.rawScore,
        bucket,
        pubDateMs,
        addedMs,
        createdAtMs: parseMs(rep.createdAt),
        highPriority,
      },
    });
  }

  breaking.sort((a, b) => {
    const ra = a.data.rawScore ?? Number.NEGATIVE_INFINITY;
    const rb = b.data.rawScore ?? Number.NEGATIVE_INFINITY;
    if (ra !== rb) return rb - ra;
    const pa = parseMs(a.data.firstPubDate);
    const pb = parseMs(b.data.firstPubDate);
    if (pa !== pb) return pb - pa;
    return a.data._id < b.data._id ? -1 : 1;
  });

  // 4. Assign each remaining group to a fact section. A story folds into the
  //    fact it matched even at ZERO signal (lenient ownership), so low-priority
  //    suggestions live inside the fact section they're part of rather than a
  //    separate "Also for you" catch-all. A group with no fact to belong to —
  //    a negative (suppressed) match, or a factless one (tracked/exploration/
  //    deleted-fact topics) — resolves to null and is dropped from the Dashboard.
  //    A TOP-HEADLINE row has synthetic matched topics (`topicId: null`), so it
  //    can never resolve an owning fact and used to be dropped here — it reached
  //    the device, was scored, and rendered on the Feed tab, but the Dashboard
  //    threw it away. It now falls through to its SCOPE section instead. Fact
  //    ownership still wins when both apply: a headline that also matched a real
  //    persona topic is about that fact, and showing it in both places would
  //    duplicate the card.
  const factRows = new Map<string, FactRow>();

  // Headline section SHELLS, created up-front from the denominators (step 0) so
  // a scope with headlines but no qualifying member still renders its title +
  // its "none looked relevant today" line.
  const headlineRows = new Map<string, FactRow>();
  for (const [sectionId, readCount] of headlineReadCounts) {
    const countryCode = headlineCountries.get(sectionId) ?? null;
    const isGlobal = sectionId === GLOBAL_HEADLINE_SECTION_ID;
    headlineRows.set(sectionId, {
      factId: sectionId,
      kind: isGlobal ? 'headline-global' : 'headline-country',
      countryCode,
      headlineReadCount: readCount,
      weight: isGlobal
        ? headlineSectionWeight('GLOBAL', null, config)
        : headlineSectionWeight(
            'COUNTRY',
            countryCode ? countryLocationWeight(snapshots.locations, countryCode) : null,
            config,
          ),
      // Localized in the UI layer from `kind` + `countryCode` — see FactRow.
      statement: '',
      factStatement: null,
      latestAddedMs: 0,
      unreadCount: 0,
      groups: [],
    });
  }

  for (const { rep, group } of assignable) {
    // RULE 1 (see feed-select/ownership): the pipeline already discarded this
    // row — its relevance never cleared `discardFloor` — so its fact match is
    // not relevance-backed and it must not claim a section. `RENDER_GATE` (0.3)
    // is looser than `discardFloor` (0.4), which is how these rows got here.
    // Applied to headline sections IDENTICALLY, per the brief: the bar is the
    // existing one, not a new one.
    if (!isSectionMemberEligible(group.bucket)) continue;
    const projection = ownershipProjection(rep);
    const factId = resolveOwningFactLenient(
      projection,
      snapshots.topics,
      snapshots.facts,
      hpMult,
    );
    if (!factId) {
      // No fact owns it. A top-headline row still has a home — its scope's
      // section. Anything else (negative/suppressed or factless) stays dropped.
      const sectionId = headlineSectionIdOf(projection);
      if (sectionId) headlineRows.get(sectionId)?.groups.push(group);
      continue;
    }
    let row = factRows.get(factId);
    if (!row) {
      const fact = snapshots.facts.get(factId);
      row = {
        factId,
        kind: 'fact',
        weight: fact?.weight ?? 1,
        statement: fact?.statement?.trim() || factId,
        factStatement: snapshots.factStatements.get(factId) ?? null,
        latestAddedMs: 0,
        unreadCount: 0,
        groups: [],
      };
      factRows.set(factId, row);
    }
    row.groups.push(group);
  }

  // 5. Finalize each row: order cards createdAt-desc, compute unread counts.
  const isGroupUnread = (g: FactRowGroup) => !isSuggestionOpened(g.data, openedIds);
  const rows: FactRow[] = [];
  for (const row of factRows.values()) {
    // RULE 2 (see feed-select/ownership): a section headed "News about: X" needs
    // at least one story that is actually about X. When every surviving match is
    // LOW, the fact has no coverage right now — only the tail of a similarity
    // search — so the section is dropped rather than filled with articles whose
    // own rationale disclaims the link. Sections WITH real coverage keep their
    // LOW stories, so active sections are unchanged.
    if (!isFactSectionViable(row.groups.map((g) => g.bucket))) continue;
    row.groups.sort(cardCompare);
    row.latestAddedMs = row.groups.reduce((mx, g) => Math.max(mx, g.addedMs), 0);
    row.unreadCount = row.groups.filter(isGroupUnread).length;
    rows.push(row);
  }

  // 5b. Finalize the headline sections. RULE 2 is applied with the SAME test and
  //     now the SAME consequence as a fact section: a non-viable headline
  //     section disappears.
  //
  //     This used to keep the shell and empty its cards, on the argument that
  //     the one-line denominator ("Mera read 20 · none looked relevant today")
  //     was the only place a reader learns Mera did work on their behalf. The
  //     user overruled that after living with it: an empty section reads as a
  //     promise of content followed by an admission there is none, and it cost a
  //     screenful every time. Their standing rule for this feature — "if not
  //     relevant we're saving users time by not showing it" — decides it.
  //
  //     Note the shell was ALSO masking a real defect: until headlines P8, every
  //     pure headline row was written off before scoring, so the shell was the
  //     permanent state of the feature rather than an occasional honest empty.
  //     Anyone tempted to restore it should first confirm the sections can fill.
  for (const row of headlineRows.values()) {
    if (!isFactSectionViable(row.groups.map((g) => g.bucket))) continue;
    row.groups.sort(cardCompare);
    row.latestAddedMs = row.groups.reduce((mx, g) => Math.max(mx, g.addedMs), 0);
    row.unreadCount = row.groups.filter(isGroupUnread).length;
    rows.push(row);
  }

  // Section order (Dashboard live resort): section WEIGHT desc first — the one
  // axis on which synthetic headline sections are comparable with real fact
  // sections (a default-weight fact is 1.0, a full-weight home country 0.55,
  // GLOBAL 0.35; see `headlineSectionWeight`) — then unread count desc (a
  // fully-read section sinks below any section with at least one unread story),
  // then by group count desc, ties broken by factId asc for determinism.
  rows.sort((a, b) => {
    const wa = a.weight ?? 1;
    const wb = b.weight ?? 1;
    if (wa !== wb) return wb - wa;
    if (a.unreadCount !== b.unreadCount) return b.unreadCount - a.unreadCount;
    if (a.groups.length !== b.groups.length) return b.groups.length - a.groups.length;
    return a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0;
  });

  return { breaking, rows };
}

/** Raw predicate behind `isSuggestionOpened`: true when `articleId` OR
 *  `stableClusterId` (if present) is in the opened set. Exported separately so
 *  callers that only have an article id + stable cluster id (no full
 *  `ForYouSuggestion`) — e.g. the article-detail screen — can reuse the exact
 *  same opened-set check without constructing a fake suggestion. */
export function isOpenedId(
  articleId: string | null | undefined,
  stableClusterId: string | null | undefined,
  openedSet: Set<string>,
): boolean {
  if (openedSet.size === 0) return false;
  if (articleId && openedSet.has(articleId)) return true;
  if (stableClusterId && openedSet.has(stableClusterId)) return true;
  return false;
}

/** True when a suggestion's article_id OR top stable cluster id is in the opened
 *  set — the card-dimming predicate. Ported from the deleted feed-sections
 *  selector. */
export function isSuggestionOpened(s: ForYouSuggestion, openedSet: Set<string>): boolean {
  const topStable = s.clusters?.find((c) => c.stableClusterId)?.stableClusterId;
  return isOpenedId(s.articleId, topStable, openedSet);
}
