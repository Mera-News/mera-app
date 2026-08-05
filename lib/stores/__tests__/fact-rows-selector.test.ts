// fact-rows-selector — pure selector tests (Round-3 C1). RN-free.
//
// Ports the render-gate + ownership/orphan/negative cases from the deleted
// feed-sections-selector suite, adapted to the fact-rows output, and adds the
// Round-3-specific rules: note-gated visibility, reorder-on-new-article, and the
// cluster-timestamp (= newest member's pubDate) rule. The broad fixture models
// the user's real device dump shape (37 fact rows + eleven factless stories that
// are now dropped — no "Also for you" catch-all).

import {
  buildFactRows,
  isSuggestionOpened,
  isComplete,
  isVisible,
  isWithinWindow,
  passesRenderGate,
  FEED_WINDOW_MS,
  RENDER_GATE,
  type FactRowsSnapshots,
} from '../fact-rows-selector';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import type { UserGeoLanguageContext } from '@/lib/feed-grouping/geo-language-priority';
import type { ForYouSuggestion } from '../for-you-store';

const NOW = 1_000_000_000_000; // fixed clock
const H = 3_600_000;

let seq = 0;
function sugg(o: Partial<ForYouSuggestion> = {}): ForYouSuggestion {
  seq += 1;
  const id = o._id ?? `s${seq}`;
  const pub = new Date(o.firstPubDate ? Date.parse(o.firstPubDate) : NOW - H).toISOString();
  return {
    _id: id,
    articleId: o.articleId ?? `art-${id}`,
    clusters: o.clusters ?? [],
    relevance: o.relevance ?? 0.6,
    reason: o.reason ?? 'because',
    status: o.status ?? ArticleSuggestionStatus.Complete,
    country_code: o.country_code ?? null,
    language_code: o.language_code ?? 'en',
    publication_name: o.publication_name ?? 'Pub',
    // Default to no title so fixtures never accidentally story-merge via shared
    // title tokens; grouping tests opt in via shared clusters instead.
    title_en: o.title_en ?? null,
    title_original: o.title_original ?? null,
    description_en: o.description_en ?? null,
    article_url: o.article_url ?? null,
    image_url: o.image_url ?? null,
    userTopicIds: o.userTopicIds ?? [],
    createdAt: o.createdAt ?? new Date(NOW - H).toISOString(),
    firstPubDate: o.firstPubDate ?? pub,
    rawScore: o.rawScore ?? 0.5,
    eventType: o.eventType ?? null,
    headlineScope: o.headlineScope ?? null,
    matchedTopics: o.matchedTopics ?? [],
    factIds: o.factIds ?? [],
    scoredAt: o.scoredAt ?? null,
  };
}

function snapshots(
  topics: [string, { factId: string | null; weight?: number; highPriority?: boolean; status?: string }][],
  facts: [string, { weight?: number | null; createdAtMs?: number; statement?: string }][],
): FactRowsSnapshots {
  return {
    topics: new Map(
      topics.map(([id, t]) => [
        id,
        { factId: t.factId, weight: t.weight ?? 0.8, highPriority: t.highPriority ?? false, status: t.status ?? 'active' },
      ]),
    ),
    facts: new Map(
      facts.map(([id, f]) => [
        id,
        { weight: f.weight ?? 1, createdAtMs: f.createdAtMs ?? 100, statement: f.statement ?? `Fact ${id}` },
      ]),
    ),
    locations: new Map(),
    factStatements: new Map(facts.map(([id, f]) => [id, f.statement ?? `Fact ${id}`])),
  };
}

// --- ownership → fact rows ------------------------------------------------

describe('buildFactRows ownership', () => {
  it('assigns owned groups to their fact row', () => {
    const snap = snapshots(
      [['t1', { factId: 'f1' }], ['t2', { factId: 'f2' }]],
      [['f1', { statement: 'Berlin tech' }], ['f2', { statement: 'Climate' }]],
    );
    const a = sugg({ _id: 'a', matchedTopics: [{ topicId: 't1', text: 'x' }] });
    const b = sugg({ _id: 'b', matchedTopics: [{ topicId: 't2', text: 'y' }] });
    const { rows } = buildFactRows([a, b], snap, new Set(), NOW);
    const f1 = rows.find((r) => r.factId === 'f1');
    const f2 = rows.find((r) => r.factId === 'f2');
    expect(f1?.statement).toBe('Berlin tech');
    expect(f1?.groups.map((g) => g.data._id)).toEqual(['a']);
    expect(f2?.groups.map((g) => g.data._id)).toEqual(['b']);
  });

  it('a factless orphan (retired topic → no active fact) is DROPPED — no "Also for you"', () => {
    const snap = snapshots(
      [['t-own', { factId: 'f-own' }], ['t-orph', { factId: 'f-orph', status: 'retired' }]],
      [['f-own', { statement: 'Owned' }], ['f-orph', { statement: 'Orphan' }]],
    );
    const owned = sugg({ _id: 'own', matchedTopics: [{ topicId: 't-own', text: 'o' }] });
    const orphan = sugg({ _id: 'orph', matchedTopics: [{ topicId: 't-orph', text: 'a' }] });
    const { rows } = buildFactRows([owned, orphan], snap, new Set(), NOW);
    // No catch-all row exists anymore; every row is a real fact section.
    expect(rows.some((r) => r.factId === 'also')).toBe(false);
    // The owned story shows; the factless orphan is dropped entirely.
    expect(rows.find((r) => r.factId === 'f-own')?.groups.map((g) => g.data._id)).toEqual(['own']);
    expect(rows.some((r) => r.groups.some((g) => g.data._id === 'orph'))).toBe(false);
    expect(rows.some((r) => r.factId === 'f-orph')).toBe(false);
  });

  // --- relevance-backed section membership -------------------------------
  //
  // Regression suite for the "News about: Learning Dutch" bug: a section headed
  // after a fact held five EU-AI-labelling stories, one of which rendered Mera's
  // own "no direct tie to your Dutch learning" rationale INSIDE the section that
  // claimed it. Ownership answers "which fact did this MATCH?" from topic
  // weights alone; these two rules add the missing relevance backing.

  it('RENDER_GATE == discardFloor (relevance v3): the historic sub-discardFloor gap is CLOSED', () => {
    // Pre-v3, RENDER_GATE (0.3) was looser than discardFloor (0.4): a row at
    // 0.35 was feed-"visible" yet already discarded by the pipeline
    // (bucketOf → UNSCORED), and Rule 1 (isSectionMemberEligible) existed to
    // catch exactly that gap before it could claim a fact section. RENDER_GATE
    // is now 0.4 — numerically identical to discardFloor — so nothing
    // sub-discardFloor can reach `buildFactRows` at all any more: the gap Rule 1
    // guarded against no longer has a way to occur.
    const snap = snapshots(
      [['t1', { factId: 'f1' }]],
      [['f1', { statement: 'Learning Dutch' }]],
    );
    const subGate = sugg({ _id: 'sub', relevance: 0.39, matchedTopics: [{ topicId: 't1', text: 'x' }] });
    // Exactly at the (now-shared) gate/floor cutoff: renders, buckets LOW, and
    // — per the "0.4-bucketed LOW rows must stay included" decision — still
    // claims its section (Rule 1 no longer excludes it). A HIGH-bucketed sibling
    // (`real`) is included purely to satisfy Rule 2's section-viability floor
    // (isFactSectionViable — a section with only LOW members is dropped
    // entirely; that is a SEPARATE rule from the one this test targets, see
    // `RULE 2` below).
    const atGate = sugg({ _id: 'at-gate', relevance: 0.4, matchedTopics: [{ topicId: 't1', text: 'x' }] });
    const real = sugg({ _id: 'real', relevance: 0.8, matchedTopics: [{ topicId: 't1', text: 'x' }] });
    expect(passesRenderGate(subGate)).toBe(false); // never reaches the visible pool
    expect(passesRenderGate(atGate)).toBe(true);
    const { rows } = buildFactRows([subGate, atGate, real], snap, new Set(), NOW);
    const f1 = rows.find((r) => r.factId === 'f1');
    expect(f1?.groups.map((g) => g.data._id).sort()).toEqual(['at-gate', 'real']);
  });

  it('RULE 2: a fact whose every match is LOW gets NO section', () => {
    const snap = snapshots(
      [['t-nl', { factId: 'f-nl' }]],
      [['f-nl', { statement: 'Learning Dutch' }]],
    );
    // The reported shape: five matched stories, every one of them LOW.
    const lows = [1, 2, 3, 4, 5].map((n) =>
      sugg({ _id: `low${n}`, relevance: 0.4, matchedTopics: [{ topicId: 't-nl', text: 'nl' }] }),
    );
    const { rows } = buildFactRows(lows, snap, new Set(), NOW);
    expect(rows.some((r) => r.factId === 'f-nl')).toBe(false);
  });

  it('RULE 2: one MEDIUM story makes the section viable and its LOW stories are KEPT', () => {
    const snap = snapshots(
      [['t1', { factId: 'f1' }]],
      [['f1', { statement: 'Berlin tech' }]],
    );
    const low = sugg({ _id: 'low', relevance: 0.4, matchedTopics: [{ topicId: 't1', text: 'x' }] });
    const med = sugg({ _id: 'med', relevance: 0.6, matchedTopics: [{ topicId: 't1', text: 'x' }] });
    const { rows } = buildFactRows([low, med], snap, new Set(), NOW);
    const f1 = rows.find((r) => r.factId === 'f1');
    // Active sections are NOT thinned — this is a per-section test, not per-card.
    expect(f1?.groups.map((g) => g.data._id).sort()).toEqual(['low', 'med']);
  });

  it('an all-LOW fact is dropped WITHOUT disturbing a sibling fact that has real coverage', () => {
    const snap = snapshots(
      [['t-nl', { factId: 'f-nl' }], ['t-ok', { factId: 'f-ok' }]],
      [['f-nl', { statement: 'Learning Dutch' }], ['f-ok', { statement: 'F1' }]],
    );
    const low = sugg({ _id: 'low', relevance: 0.4, matchedTopics: [{ topicId: 't-nl', text: 'nl' }] });
    const ok = sugg({ _id: 'ok', relevance: 0.8, matchedTopics: [{ topicId: 't-ok', text: 'f1' }] });
    const { rows } = buildFactRows([low, ok], snap, new Set(), NOW);
    expect(rows.map((r) => r.factId)).toEqual(['f-ok']);
  });

  it('EMERGENCY/HIGH buckets also make a section viable', () => {
    const snap = snapshots([['t1', { factId: 'f1' }]], [['f1', { statement: 'X' }]]);
    // rawScore kept sub-breaking so the row stays a section member rather than
    // being pulled into the breaking strip before assignment.
    const high = sugg({ _id: 'h', relevance: 0.85, rawScore: 0.5, matchedTopics: [{ topicId: 't1', text: 'x' }] });
    const { rows } = buildFactRows([high], snap, new Set(), NOW);
    expect(rows.find((r) => r.factId === 'f1')?.groups.map((g) => g.data._id)).toEqual(['h']);
  });

  it('a zero-signal but ACTIVE fact match folds into that fact section', () => {
    const snap = snapshots(
      [['t-zero', { factId: 'f-zero', weight: 0 }]], // active, but effective weight 0
      [['f-zero', { statement: 'Low signal' }]],
    );
    const s = sugg({ _id: 'z', matchedTopics: [{ topicId: 't-zero', text: 'z' }] });
    const { rows } = buildFactRows([s], snap, new Set(), NOW);
    const fz = rows.find((r) => r.factId === 'f-zero');
    expect(fz?.groups.map((g) => g.data._id)).toEqual(['z']);
    expect(rows.some((r) => r.factId === 'also')).toBe(false);
  });

  it('negative match (down-weighted topic) is DROPPED, not shown', () => {
    const snap = snapshots(
      [['tn', { factId: 'fn', weight: -0.8 }]],
      [['fn', { statement: 'Suppressed' }]],
    );
    const neg = sugg({ _id: 'neg', relevance: 0.6, matchedTopics: [{ topicId: 'tn', text: 'x' }] });
    const { rows } = buildFactRows([neg], snap, new Set(), NOW);
    const shown = rows.flatMap((r) => r.groups.map((g) => g.data._id));
    expect(shown).not.toContain('neg');
    expect(rows).toHaveLength(0);
  });
});

// --- render gate + note-gated visibility ----------------------------------

describe('buildFactRows visibility', () => {
  const snap = snapshots([['t1', { factId: 'f1' }]], [['f1', {}]]);

  it('drops sub-render-gate (relevance < RENDER_GATE, 0.4) rows', () => {
    const lo = sugg({ _id: 'lo', relevance: 0.28, matchedTopics: [{ topicId: 't1', text: 'x' }] });
    const { rows } = buildFactRows([lo], snap, new Set(), NOW);
    expect(rows).toHaveLength(0);
  });

  it('hides reason_pending rows (note not written yet), shows complete ones', () => {
    const pending = sugg({
      _id: 'pending',
      status: ArticleSuggestionStatus.ReasonPending,
      matchedTopics: [{ topicId: 't1', text: 'x' }],
    });
    const complete = sugg({
      _id: 'complete',
      status: ArticleSuggestionStatus.Complete,
      matchedTopics: [{ topicId: 't1', text: 'y' }],
    });
    const { rows } = buildFactRows([pending, complete], snap, new Set(), NOW);
    const shown = rows.flatMap((r) => r.groups.map((g) => g.data._id));
    expect(shown).toContain('complete');
    expect(shown).not.toContain('pending');
  });

  it('a reasonSkipped row (complete, empty reason) renders immediately', () => {
    const skipped = sugg({
      _id: 'skip',
      status: ArticleSuggestionStatus.Complete,
      reason: '', // note deliberately skipped for a sub-threshold-reason row
      // MEDIUM, so the section-viability rule (all-LOW sections are dropped —
      // see the relevance-backed-membership suite) can't mask what this case is
      // actually about: the NOTE gate, not the bucket.
      relevance: 0.6,
      matchedTopics: [{ topicId: 't1', text: 'x' }],
    });
    const { rows } = buildFactRows([skipped], snap, new Set(), NOW);
    expect(rows.flatMap((r) => r.groups.map((g) => g.data._id))).toContain('skip');
  });

  it('drops rows outside the publication window', () => {
    const old = sugg({
      _id: 'old',
      firstPubDate: new Date(NOW - FEED_WINDOW_MS - H).toISOString(),
      matchedTopics: [{ topicId: 't1', text: 'x' }],
    });
    const { rows } = buildFactRows([old], snap, new Set(), NOW);
    expect(rows).toHaveLength(0);
  });
});

// --- cluster-timestamp rule (newest member fronts) ------------------------

describe('buildFactRows cluster timestamp', () => {
  it('picks the newest member as representative; group pubDate = newest', () => {
    const snap = snapshots([['t1', { factId: 'f1' }]], [['f1', {}]]);
    const older = sugg({
      _id: 'older',
      firstPubDate: new Date(NOW - 5 * H).toISOString(),
      clusters: [{ clusterId: 'c1', confidence: 0.9 }],
      matchedTopics: [{ topicId: 't1', text: 'x' }],
    });
    const newer = sugg({
      _id: 'newer',
      firstPubDate: new Date(NOW - 1 * H).toISOString(),
      clusters: [{ clusterId: 'c1', confidence: 0.9 }],
      matchedTopics: [{ topicId: 't1', text: 'y' }],
    });
    const { rows } = buildFactRows([older, newer], snap, new Set(), NOW);
    const f1 = rows.find((r) => r.factId === 'f1')!;
    expect(f1.groups).toHaveLength(1); // collapsed via shared cluster
    expect(f1.groups[0].data._id).toBe('newer'); // newest fronts
    expect(f1.groups[0].pubDateMs).toBe(NOW - 1 * H);
    expect(f1.groups[0].members.map((m) => m._id)).toEqual(['older']);
  });
});

// --- representative election (geo/language priority, Wave 2b) --------------

describe('buildFactRows representative election (geo/language priority)', () => {
  const snap = snapshots([['t1', { factId: 'f1' }]], [['f1', {}]]);

  it('home-country sibling becomes representative even when another sibling is newer', () => {
    const ctx: UserGeoLanguageContext = {
      homeCountryAlpha3: 'IND',
      otherCountriesAlpha3: [],
      appLanguageBase: 'en',
    };
    const home = sugg({
      _id: 'home',
      country_code: 'IND',
      firstPubDate: new Date(NOW - 5 * H).toISOString(),
      rawScore: 0.4,
      clusters: [{ clusterId: 'c1', confidence: 0.9 }],
      matchedTopics: [{ topicId: 't1', text: 'x' }],
    });
    const newer = sugg({
      _id: 'newer',
      country_code: 'USA',
      firstPubDate: new Date(NOW - 1 * H).toISOString(),
      rawScore: 0.9,
      clusters: [{ clusterId: 'c1', confidence: 0.9 }],
      matchedTopics: [{ topicId: 't1', text: 'y' }],
    });
    const { rows } = buildFactRows([home, newer], snap, new Set(), NOW, DEFAULT_HARNESS_CONFIG, ctx);
    const f1 = rows.find((r) => r.factId === 'f1')!;
    expect(f1.groups).toHaveLength(1);
    expect(f1.groups[0].data._id).toBe('home');
    expect(f1.groups[0].members.map((m) => m._id)).toEqual(['newer']);
  });

  it('an other-user-country sibling beats an app-language-match sibling', () => {
    const ctx: UserGeoLanguageContext = {
      homeCountryAlpha3: null,
      otherCountriesAlpha3: ['GBR'],
      appLanguageBase: 'fr',
    };
    const otherCountry = sugg({
      _id: 'gbr',
      country_code: 'GBR',
      language_code: 'en',
      firstPubDate: new Date(NOW - 5 * H).toISOString(),
      rawScore: 0.3,
      clusters: [{ clusterId: 'c2', confidence: 0.9 }],
      matchedTopics: [{ topicId: 't1', text: 'x' }],
    });
    const langMatch = sugg({
      _id: 'fr',
      country_code: null,
      language_code: 'fr',
      firstPubDate: new Date(NOW - 1 * H).toISOString(),
      rawScore: 0.9,
      clusters: [{ clusterId: 'c2', confidence: 0.9 }],
      matchedTopics: [{ topicId: 't1', text: 'y' }],
    });
    const { rows } = buildFactRows([otherCountry, langMatch], snap, new Set(), NOW, DEFAULT_HARNESS_CONFIG, ctx);
    const f1 = rows.find((r) => r.factId === 'f1')!;
    expect(f1.groups[0].data._id).toBe('gbr');
  });

  it('a null userCtx keeps the legacy newest/rawScore-based pick', () => {
    const older = sugg({
      _id: 'older',
      country_code: 'IND',
      firstPubDate: new Date(NOW - 5 * H).toISOString(),
      rawScore: 0.4,
      clusters: [{ clusterId: 'c3', confidence: 0.9 }],
      matchedTopics: [{ topicId: 't1', text: 'x' }],
    });
    const newer = sugg({
      _id: 'newer',
      country_code: 'USA',
      firstPubDate: new Date(NOW - 1 * H).toISOString(),
      rawScore: 0.9,
      clusters: [{ clusterId: 'c3', confidence: 0.9 }],
      matchedTopics: [{ topicId: 't1', text: 'y' }],
    });
    const { rows } = buildFactRows([older, newer], snap, new Set(), NOW, DEFAULT_HARNESS_CONFIG, null);
    const f1 = rows.find((r) => r.factId === 'f1')!;
    expect(f1.groups[0].data._id).toBe('newer');
  });
});

// --- section ordering + unread / high-priority fields ----------------------

describe('buildFactRows section ordering', () => {
  it('orders sections by unreadCount desc, then group count desc, then factId asc — a 0-unread section sinks below any non-zero section', () => {
    const snap = snapshots(
      [
        ['t1', { factId: 'fA' }],
        ['t2', { factId: 'fB' }],
        ['t3', { factId: 'fC' }],
        ['t4', { factId: 'fD' }],
      ],
      [['fA', {}], ['fB', {}], ['fC', {}], ['fD', {}]],
    );
    // fA: 2 groups, both unread → unreadCount 2.
    const a1 = sugg({ _id: 'a1', articleId: 'art-a1', clusters: [{ clusterId: 'ca1', confidence: 0.9 }], matchedTopics: [{ topicId: 't1', text: 'x' }] });
    const a2 = sugg({ _id: 'a2', articleId: 'art-a2', clusters: [{ clusterId: 'ca2', confidence: 0.9 }], matchedTopics: [{ topicId: 't1', text: 'y' }] });
    // fB: 3 groups, 2 already opened → unreadCount 1, groups.length 3.
    const b1 = sugg({ _id: 'b1', articleId: 'art-b1', clusters: [{ clusterId: 'cb1', confidence: 0.9 }], matchedTopics: [{ topicId: 't2', text: 'x' }] });
    const b2 = sugg({ _id: 'b2', articleId: 'art-b2', clusters: [{ clusterId: 'cb2', confidence: 0.9 }], matchedTopics: [{ topicId: 't2', text: 'y' }] });
    const b3 = sugg({ _id: 'b3', articleId: 'art-b3', clusters: [{ clusterId: 'cb3', confidence: 0.9 }], matchedTopics: [{ topicId: 't2', text: 'z' }] });
    // fC: 1 group, unread → unreadCount 1, groups.length 1 — ties fB on unreadCount,
    // loses the group-count tiebreak.
    const c1 = sugg({ _id: 'c1', articleId: 'art-c1', matchedTopics: [{ topicId: 't3', text: 'x' }] });
    // fD: 2 groups, BOTH already opened → unreadCount 0 — sinks last despite having
    // more groups than fC.
    const d1 = sugg({ _id: 'd1', articleId: 'art-d1', clusters: [{ clusterId: 'cd1', confidence: 0.9 }], matchedTopics: [{ topicId: 't4', text: 'x' }] });
    const d2 = sugg({ _id: 'd2', articleId: 'art-d2', clusters: [{ clusterId: 'cd2', confidence: 0.9 }], matchedTopics: [{ topicId: 't4', text: 'y' }] });

    const opened = new Set(['art-b2', 'art-b3', 'art-d1', 'art-d2']);
    const { rows } = buildFactRows([a1, a2, b1, b2, b3, c1, d1, d2], snap, opened, NOW);
    expect(rows.map((r) => r.factId)).toEqual(['fA', 'fB', 'fC', 'fD']);
    expect(rows.map((r) => r.unreadCount)).toEqual([2, 1, 1, 0]);
  });

  it('breaks an unreadCount + group-count tie by factId ascending', () => {
    const snap = snapshots(
      [['t1', { factId: 'fZ' }], ['t2', { factId: 'fA' }]],
      [['fZ', {}], ['fA', {}]],
    );
    const z = sugg({ _id: 'z', matchedTopics: [{ topicId: 't1', text: 'x' }] });
    const a = sugg({ _id: 'a', matchedTopics: [{ topicId: 't2', text: 'y' }] });
    const { rows } = buildFactRows([z, a], snap, new Set(), NOW);
    expect(rows.map((r) => r.factId)).toEqual(['fA', 'fZ']);
  });

  it('flags a HIGH-bucket group as high-priority', () => {
    const snap = snapshots([['t1', { factId: 'f1' }]], [['f1', {}]]);
    const hi = sugg({ _id: 'hi', relevance: 0.85, matchedTopics: [{ topicId: 't1', text: 'x' }] });
    const f1 = buildFactRows([hi], snap, new Set(), NOW).rows.find((r) => r.factId === 'f1')!;
    expect(f1.groups[0].highPriority).toBe(true);
  });

  it('computes unreadCount, clearing it once the story is opened', () => {
    const snap = snapshots([['t1', { factId: 'f1' }]], [['f1', {}]]);
    const hi = sugg({ _id: 'hi', articleId: 'art-hi', relevance: 0.85, matchedTopics: [{ topicId: 't1', text: 'x' }] });
    const before = buildFactRows([hi], snap, new Set(), NOW).rows.find((r) => r.factId === 'f1')!;
    expect(before.unreadCount).toBe(1);

    const after = buildFactRows([hi], snap, new Set(['art-hi']), NOW).rows.find((r) => r.factId === 'f1')!;
    expect(after.unreadCount).toBe(0);
  });

  it('orders cards within a section by representative createdAt desc', () => {
    const snap = snapshots([['t1', { factId: 'f1' }]], [['f1', {}]]);
    const early = sugg({
      _id: 'early',
      createdAt: new Date(NOW - 5 * H).toISOString(),
      clusters: [{ clusterId: 'ce', confidence: 0.9 }],
      matchedTopics: [{ topicId: 't1', text: 'a' }],
    });
    const late = sugg({
      _id: 'late',
      createdAt: new Date(NOW - 1 * H).toISOString(),
      clusters: [{ clusterId: 'cl', confidence: 0.9 }],
      matchedTopics: [{ topicId: 't1', text: 'b' }],
    });
    const f1 = buildFactRows([early, late], snap, new Set(), NOW).rows.find((r) => r.factId === 'f1')!;
    expect(f1.groups.map((g) => g.data._id)).toEqual(['late', 'early']);
  });
});

// --- breaking extraction ---------------------------------------------------

describe('buildFactRows breaking extraction', () => {
  it('pulls raw>1.0 and hot-event raw≥0.8 out into the breaking strip', () => {
    const snap = snapshots([['t1', { factId: 'f1' }]], [['f1', {}]]);
    const emg = sugg({ _id: 'emg', rawScore: 1.05, relevance: 1.1, matchedTopics: [{ topicId: 't1', text: 'a' }] });
    const wx = sugg({ _id: 'wx', rawScore: 0.85, relevance: 0.8, eventType: 'weather', matchedTopics: [{ topicId: 't1', text: 'b' }] });
    const plain = sugg({ _id: 'plain', rawScore: 0.9, relevance: 0.8, eventType: 'politics', matchedTopics: [{ topicId: 't1', text: 'c' }] });
    const { breaking, rows } = buildFactRows([emg, wx, plain], snap, new Set(), NOW);
    expect(breaking.map((b) => b.data._id)).toEqual(['emg', 'wx']);
    const inRows = rows.flatMap((r) => r.groups.map((g) => g.data._id));
    expect(inRows).toContain('plain');
    expect(inRows).not.toContain('emg');
    expect(inRows).not.toContain('wx');
  });
});

// --- device-dump shape (37 fact rows; eleven factless stories dropped) ----

describe('buildFactRows device-dump shape', () => {
  it('produces 37 fact rows and drops the 11 factless (retired-topic) stories', () => {
    const topics: [string, { factId: string | null; status?: string }][] = [];
    const facts: [string, { statement?: string }][] = [];
    const rowsInput: ForYouSuggestion[] = [];

    for (let i = 0; i < 37; i++) {
      const fId = `f${i}`;
      const tId = `t${i}`;
      topics.push([tId, { factId: fId }]);
      facts.push([fId, { statement: `Fact ${i}` }]);
      rowsInput.push(
        sugg({
          _id: `owned-${i}`,
          relevance: 0.6,
          status: ArticleSuggestionStatus.Complete,
          scoredAt: NOW - (i + 1) * 60_000,
          matchedTopics: [{ topicId: tId, text: 'x' }],
        }),
      );
    }
    // Eleven relevance-0.6 complete stories whose sole owning topic RETIRED —
    // factless (no active fact), so they are DROPPED from the Dashboard (there is
    // no "Also for you" catch-all anymore).
    topics.push(['t-ai', { factId: 'f-ai', status: 'retired' }]);
    facts.push(['f-ai', { statement: 'AI news' }]);
    for (let i = 0; i < 11; i++) {
      rowsInput.push(
        sugg({
          _id: `ai-${i}`,
          relevance: 0.6,
          status: ArticleSuggestionStatus.Complete,
          matchedTopics: [{ topicId: 't-ai', text: 'AI' }],
        }),
      );
    }

    const snap = snapshots(topics, facts);
    const { rows } = buildFactRows(rowsInput, snap, new Set(), NOW);
    // Every row is a real fact section — 37 of them.
    expect(rows).toHaveLength(37);
    // No catch-all; the 11 retired-topic (factless) stories are dropped.
    expect(rows.some((r) => r.factId === 'also')).toBe(false);
    expect(rows.some((r) => r.groups.some((g) => g.data._id.startsWith('ai-')))).toBe(false);
  });
});

// --- isSuggestionOpened ----------------------------------------------------

describe('isSuggestionOpened', () => {
  it('matches on article id or stable cluster id', () => {
    const s = sugg({ articleId: 'art1', clusters: [{ clusterId: 'c', confidence: 0.9, stableClusterId: 'stable1' }] });
    expect(isSuggestionOpened(s, new Set())).toBe(false);
    expect(isSuggestionOpened(s, new Set(['art1']))).toBe(true);
    expect(isSuggestionOpened(s, new Set(['stable1']))).toBe(true);
    expect(isSuggestionOpened(s, new Set(['other']))).toBe(false);
  });
});

// --- isVisible ⇄ sub-predicate drift guard --------------------------------
//
// `isVisible` was split into `isComplete` / `passesRenderGate` /
// `isWithinWindow` so `feed-diagnostics.computeFeedFunnel` can attribute WHICH
// gate rejected a row without re-implementing the comparisons. That only holds
// while the composition — and its conjunction ORDER, which the diagnostic's
// first-failure-wins attribution mirrors — stays exact. Each row below asserts
// the sub-predicates' own values AND the expected literal, so inverting all
// three (which would keep the equality tautologically true) still fails.

const CUTOFF = NOW - FEED_WINDOW_MS;

describe('isVisible composition (drift guard)', () => {
  it('equals isComplete && passesRenderGate && isWithinWindow across all 8 combinations', () => {
    const seen: boolean[] = [];
    for (const complete of [true, false]) {
      for (const aboveGate of [true, false]) {
        for (const inWindow of [true, false]) {
          const s = sugg({
            _id: `tt-${complete}-${aboveGate}-${inWindow}`,
            status: complete ? ArticleSuggestionStatus.Complete : ArticleSuggestionStatus.ReasonPending,
            relevance: aboveGate ? 0.6 : 0.2,
            firstPubDate: new Date(
              inWindow ? NOW - FEED_WINDOW_MS / 2 : NOW - FEED_WINDOW_MS - H,
            ).toISOString(),
          });
          const label = `${complete}/${aboveGate}/${inWindow}`;

          // The sub-predicates individually report what the fixture encodes...
          expect(`${label}:${isComplete(s)}`).toBe(`${label}:${complete}`);
          expect(`${label}:${passesRenderGate(s)}`).toBe(`${label}:${aboveGate}`);
          expect(`${label}:${isWithinWindow(s, CUTOFF)}`).toBe(`${label}:${inWindow}`);

          // ...and `isVisible` is exactly their conjunction. Both the literal
          // expectation (only TTT is visible) and the equality are asserted.
          const expected = complete && aboveGate && inWindow;
          expect(`${label}:${isVisible(s, CUTOFF)}`).toBe(`${label}:${expected}`);
          expect(isVisible(s, CUTOFF)).toBe(
            isComplete(s) && passesRenderGate(s) && isWithinWindow(s, CUTOFF),
          );
          seen.push(expected);
        }
      }
    }
    expect(seen).toHaveLength(8);
    expect(seen.filter(Boolean)).toHaveLength(1); // exactly one visible combination
  });

  it('INCLUDES relevance exactly at RENDER_GATE (relevance v3: the gate is inclusive, >=)', () => {
    const at = sugg({ _id: 'gate-at', relevance: RENDER_GATE });
    expect(passesRenderGate(at)).toBe(true);
    expect(isVisible(at, CUTOFF)).toBe(true);

    const under = sugg({ _id: 'gate-under', relevance: RENDER_GATE - 0.01 });
    expect(passesRenderGate(under)).toBe(false);
    expect(isVisible(under, CUTOFF)).toBe(false);
  });

  it('INCLUDES firstPubDate exactly at the cutoff (the window is >=)', () => {
    const at = sugg({ _id: 'cut-at', firstPubDate: new Date(CUTOFF).toISOString() });
    expect(isWithinWindow(at, CUTOFF)).toBe(true);
    expect(isVisible(at, CUTOFF)).toBe(true);

    const justOutside = sugg({ _id: 'cut-out', firstPubDate: new Date(CUTOFF - 1).toISOString() });
    expect(isWithinWindow(justOutside, CUTOFF)).toBe(false);
    expect(isVisible(justOutside, CUTOFF)).toBe(false);
  });
});

// --- representative election (source preferences, source-pref D3) ----------

describe('buildFactRows representative election (source preferences)', () => {
  const snap = snapshots([['t1', { factId: 'f1' }]], [['f1', {}]]);
  const PREF_CTX: UserGeoLanguageContext = {
    homeCountryAlpha3: 'USA',
    otherCountriesAlpha3: [],
    appLanguageBase: 'en',
    preferredPublications: new Set(['times of india']),
    preferredCountriesAlpha3: new Set(['IND']),
  };

  function member(o: Parameters<typeof sugg>[0]) {
    return sugg({
      clusters: [{ clusterId: 'c1', confidence: 0.9 }],
      matchedTopics: [{ topicId: 't1', text: 'x' }],
      ...o,
    });
  }

  it('a preferred publication fronts the card, outranking the home-country geo tier', () => {
    const preferred = member({
      _id: 'toi',
      publication_name: 'Times of India',
      country_code: 'IND',
      firstPubDate: new Date(NOW - 5 * H).toISOString(),
    });
    const home = member({
      _id: 'cnn',
      publication_name: 'CNN',
      country_code: 'USA',
      firstPubDate: new Date(NOW - 1 * H).toISOString(),
    });
    const { rows } = buildFactRows(
      [preferred, home], snap, new Set(), NOW, DEFAULT_HARNESS_CONFIG, PREF_CTX,
    );
    const f1 = rows.find((r) => r.factId === 'f1')!;
    expect(f1.groups[0].data._id).toBe('toi');
  });

  it('a preferred country scope fronts the card when no publication is named', () => {
    const scoped = member({
      _id: 'hindu',
      publication_name: 'The Hindu',
      country_code: 'IND',
      firstPubDate: new Date(NOW - 5 * H).toISOString(),
    });
    const other = member({
      _id: 'lemonde',
      publication_name: 'Le Monde',
      country_code: 'FRA',
      firstPubDate: new Date(NOW - 1 * H).toISOString(),
    });
    const { rows } = buildFactRows(
      [scoped, other], snap, new Set(), NOW, DEFAULT_HARNESS_CONFIG, PREF_CTX,
    );
    const f1 = rows.find((r) => r.factId === 'f1')!;
    expect(f1.groups[0].data._id).toBe('hindu');
  });

  it('REGRESSION CONTRACT: with no source preferences the result is identical to a null context', () => {
    const pool = [
      member({
        _id: 'toi',
        publication_name: 'Times of India',
        country_code: 'IND',
        firstPubDate: new Date(NOW - 5 * H).toISOString(),
      }),
      member({
        _id: 'cnn',
        publication_name: 'CNN',
        country_code: 'USA',
        firstPubDate: new Date(NOW - 1 * H).toISOString(),
      }),
    ];
    const noPrefCtx: UserGeoLanguageContext = {
      homeCountryAlpha3: null,
      otherCountriesAlpha3: [],
      appLanguageBase: null,
    };
    const baseline = buildFactRows(pool, snap, new Set(), NOW, DEFAULT_HARNESS_CONFIG, null);
    expect(buildFactRows(pool, snap, new Set(), NOW, DEFAULT_HARNESS_CONFIG, noPrefCtx))
      .toEqual(baseline);
    expect(
      buildFactRows(pool, snap, new Set(), NOW, DEFAULT_HARNESS_CONFIG, {
        ...noPrefCtx,
        preferredPublications: new Set(),
        preferredCountriesAlpha3: new Set(),
      }),
    ).toEqual(baseline);
  });
});
