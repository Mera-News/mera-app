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
  buildProvisionalRow,
  isSuggestionOpened,
  ALSO_ROW_ID,
  PROVISIONAL_ROW_ID,
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
  it('orders sections: unread high-priority first, then group count desc, then factId asc', () => {
    const snap = snapshots(
      [
        ['t1', { factId: 'f1' }],
        ['t2', { factId: 'f2' }],
        ['t3', { factId: 'f3', highPriority: true }],
      ],
      [['f1', {}], ['f2', {}], ['f3', {}]],
    );
    // f1: two (distinct-cluster) groups. f2: one group. f3: one HP group (unread).
    const f1a = sugg({ _id: 'f1a', clusters: [{ clusterId: 'g1a', confidence: 0.9 }], matchedTopics: [{ topicId: 't1', text: 'x' }] });
    const f1b = sugg({ _id: 'f1b', clusters: [{ clusterId: 'g1b', confidence: 0.9 }], matchedTopics: [{ topicId: 't1', text: 'y' }] });
    const f2a = sugg({ _id: 'f2a', matchedTopics: [{ topicId: 't2', text: 'z' }] });
    const f3a = sugg({ _id: 'f3a', matchedTopics: [{ topicId: 't3', text: 'hp' }] });
    const { rows } = buildFactRows([f1a, f1b, f2a, f3a], snap, new Set(), NOW);
    expect(rows.map((r) => r.factId)).toEqual(['f3', 'f1', 'f2']);
  });

  it('flags a HIGH-bucket group as high-priority', () => {
    const snap = snapshots([['t1', { factId: 'f1' }]], [['f1', {}]]);
    const hi = sugg({ _id: 'hi', relevance: 0.85, matchedTopics: [{ topicId: 't1', text: 'x' }] });
    const f1 = buildFactRows([hi], snap, new Set(), NOW).rows.find((r) => r.factId === 'f1')!;
    expect(f1.groups[0].highPriority).toBe(true);
    expect(f1.hasUnreadHighPriority).toBe(true);
  });

  it('computes unreadCount and clears the HP flag once the story is opened', () => {
    const snap = snapshots([['t1', { factId: 'f1' }]], [['f1', {}]]);
    const hi = sugg({ _id: 'hi', articleId: 'art-hi', relevance: 0.85, matchedTopics: [{ topicId: 't1', text: 'x' }] });
    const before = buildFactRows([hi], snap, new Set(), NOW).rows.find((r) => r.factId === 'f1')!;
    expect(before.unreadCount).toBe(1);
    expect(before.hasUnreadHighPriority).toBe(true);

    const after = buildFactRows([hi], snap, new Set(['art-hi']), NOW).rows.find((r) => r.factId === 'f1')!;
    expect(after.unreadCount).toBe(0);
    expect(after.hasUnreadHighPriority).toBe(false);
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

// --- provisional (pre-scoring) placeholder row -----------------------------

describe('buildProvisionalRow', () => {
  it('builds one UNSCORED "provisional" row from unscored + in-window rows', () => {
    const u = sugg({ _id: 'u', status: ArticleSuggestionStatus.Unscored, relevance: 0 });
    const c = sugg({ _id: 'c', status: ArticleSuggestionStatus.Complete, relevance: 0.6 });
    const row = buildProvisionalRow([u, c], new Set(), NOW);
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('provisional');
    expect(row!.factId).toBe(PROVISIONAL_ROW_ID);
    expect(PROVISIONAL_ROW_ID).toBe('provisional');
    expect(row!.statement).toBe(PROVISIONAL_ROW_ID);
    expect(row!.factStatement).toBeNull();
    expect(row!.hasUnreadHighPriority).toBe(false);
    // Every card carries the UNSCORED bucket.
    expect(row!.groups.every((g) => g.bucket === 'UNSCORED')).toBe(true);
    expect(row!.groups.map((g) => g.data._id).sort()).toEqual(['c', 'u']);
  });

  it('orders cards newest firstPubDate first (id ascending on a tie)', () => {
    const older = sugg({ _id: 'a', status: ArticleSuggestionStatus.Unscored, firstPubDate: new Date(NOW - 3 * H).toISOString() });
    const newer = sugg({ _id: 'b', status: ArticleSuggestionStatus.Unscored, firstPubDate: new Date(NOW - 1 * H).toISOString() });
    const row = buildProvisionalRow([older, newer], new Set(), NOW)!;
    expect(row.groups.map((g) => g.data._id)).toEqual(['b', 'a']);
  });

  it('drops discarded (complete && relevance ≤ gate) + out-of-window rows, admits unscored', () => {
    const disc = sugg({ _id: 'disc', status: ArticleSuggestionStatus.Complete, relevance: 0.3 });
    const stale = sugg({ _id: 'old', status: ArticleSuggestionStatus.Unscored, firstPubDate: new Date(NOW - 30 * H).toISOString() });
    const ok = sugg({ _id: 'ok', status: ArticleSuggestionStatus.Unscored, relevance: 0 });
    const row = buildProvisionalRow([disc, stale, ok], new Set(), NOW)!;
    expect(row.groups.map((g) => g.data._id)).toEqual(['ok']);
  });

  it('excludes opened/viewed ids', () => {
    const a = sugg({ _id: 'a', articleId: 'art-a', status: ArticleSuggestionStatus.Unscored });
    const b = sugg({ _id: 'b', articleId: 'art-b', status: ArticleSuggestionStatus.Unscored });
    const row = buildProvisionalRow([a, b], new Set(['art-a']), NOW)!;
    expect(row.groups.map((g) => g.data._id)).toEqual(['b']);
  });

  it('collapses a shared-cluster story into one member-carrying card', () => {
    const a = sugg({ _id: 'a', status: ArticleSuggestionStatus.Unscored, clusters: [{ clusterId: 'c1', confidence: 0.9 }], firstPubDate: new Date(NOW - 2 * H).toISOString() });
    const b = sugg({ _id: 'b', status: ArticleSuggestionStatus.Unscored, clusters: [{ clusterId: 'c1', confidence: 0.9 }], firstPubDate: new Date(NOW - 1 * H).toISOString() });
    const row = buildProvisionalRow([a, b], new Set(), NOW)!;
    expect(row.groups).toHaveLength(1);
    expect(row.groups[0].data._id).toBe('b'); // newest fronts
    expect(row.groups[0].members.map((m) => m._id)).toEqual(['a']);
  });

  it('returns null when the pool is empty / all discarded', () => {
    expect(buildProvisionalRow([], new Set(), NOW)).toBeNull();
    const disc = sugg({ status: ArticleSuggestionStatus.Complete, relevance: 0.2 });
    expect(buildProvisionalRow([disc], new Set(), NOW)).toBeNull();
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
