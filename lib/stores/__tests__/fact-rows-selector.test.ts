// fact-rows-selector — pure selector tests (Round-3 C1). RN-free.
//
// Ports the render-gate + ownership/orphan/negative cases from the deleted
// feed-sections-selector suite, adapted to the fact-rows output, and adds the
// Round-3-specific rules: note-gated visibility, reorder-on-new-article, and the
// cluster-timestamp (= newest member's pubDate) rule. The broad fixture models
// the user's real device dump shape (37 fact rows + an eleven-story 0.6 orphan
// cluster that degrades into "Also for you").

import {
  buildFactRows,
  isSuggestionOpened,
  ALSO_ROW_ID,
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
    expect(f1?.kind).toBe('fact');
    expect(f1?.groups.map((g) => g.data._id)).toEqual(['a']);
    expect(f2?.groups.map((g) => g.data._id)).toEqual(['b']);
  });

  it('zero-signal orphan (retired topic) degrades into the "also" row', () => {
    const snap = snapshots(
      [['t-own', { factId: 'f-own' }], ['t-orph', { factId: 'f-orph', status: 'retired' }]],
      [['f-own', { statement: 'Owned' }], ['f-orph', { statement: 'Orphan' }]],
    );
    const owned = sugg({ _id: 'own', matchedTopics: [{ topicId: 't-own', text: 'o' }] });
    const orphan = sugg({ _id: 'orph', matchedTopics: [{ topicId: 't-orph', text: 'a' }] });
    const { rows } = buildFactRows([owned, orphan], snap, new Set(), NOW);
    const also = rows.find((r) => r.factId === ALSO_ROW_ID);
    expect(also?.kind).toBe('also');
    expect(also?.groups.map((g) => g.data._id)).toEqual(['orph']);
    // "also" is always last.
    expect(rows[rows.length - 1].factId).toBe(ALSO_ROW_ID);
    expect(rows.some((r) => r.factId === 'f-own')).toBe(true);
    // orphan never forms a fact row.
    expect(rows.some((r) => r.factId === 'f-orph')).toBe(false);
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

  it('drops sub-render-gate (relevance ≤ 0.3) rows', () => {
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
      relevance: 0.4,
      matchedTopics: [{ topicId: 't1', text: 'x' }],
    });
    const { rows } = buildFactRows([skipped], snap, new Set(), NOW);
    expect(rows.flatMap((r) => r.groups.map((g) => g.data._id))).toContain('skip');
  });

  it('drops rows outside the 24h window', () => {
    const old = sugg({
      _id: 'old',
      firstPubDate: new Date(NOW - 30 * H).toISOString(),
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

// --- device-dump shape (37 fact rows + eleven-story 0.6 orphan cluster) ----

describe('buildFactRows device-dump shape', () => {
  it('produces 37 fact rows + one 11-story "also" row', () => {
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
    // they degrade together into "Also for you" (the real incident).
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
    const factRows = rows.filter((r) => r.kind === 'fact');
    const also = rows.find((r) => r.factId === ALSO_ROW_ID);
    expect(factRows).toHaveLength(37);
    expect(also).toBeDefined();
    expect(also!.groups).toHaveLength(11);
    expect(rows[rows.length - 1].factId).toBe(ALSO_ROW_ID);
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
