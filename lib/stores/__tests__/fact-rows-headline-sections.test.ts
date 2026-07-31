// fact-rows-selector — HEADLINE SECTIONS (P5). RN-free.
//
// Top-headline rows reach the device, get scored, and render on the Feed tab,
// but the Dashboard used to drop every one of them: they carry SYNTHETIC matched
// topics (`topicId: null`), so `resolveOwningFactLenient` returned null and a
// single `if (!factId) continue` discarded them. These tests pin the section they
// now get instead — one per COUNTRY scope, one for GLOBAL — plus the two EXISTING
// relevance rules that gate membership, the null-country rule, and the
// denominator line's counts.

import { buildFactRows, type FactRowsSnapshots } from '../fact-rows-selector';
import { GLOBAL_HEADLINE_SECTION_ID } from '@/lib/news-harness/feed-select';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import type { ForYouSuggestion } from '../for-you-store';

const NOW = 1_000_000_000_000;
const H = 3_600_000;

// Bucket boundaries this suite leans on (articlePipeline defaults):
//   < 0.4 UNSCORED · [0.4,0.6) LOW · [0.6,0.8) MEDIUM · [0.8,1.0] HIGH
// and RENDER_GATE = 0.3, which is LOOSER than discardFloor — that gap is exactly
// what Rule 1 exists to close.
const REL_UNSCORED = 0.35; // visible, but below discardFloor
const REL_LOW = 0.5;
const REL_MEDIUM = 0.7;

let seq = 0;
function sugg(o: Partial<ForYouSuggestion> = {}): ForYouSuggestion {
  seq += 1;
  const id = o._id ?? `s${seq}`;
  return {
    _id: id,
    articleId: o.articleId ?? `art-${id}`,
    clusters: o.clusters ?? [],
    relevance: o.relevance ?? REL_MEDIUM,
    reason: o.reason ?? 'because',
    status: o.status ?? ArticleSuggestionStatus.Complete,
    country_code: o.country_code ?? null,
    language_code: o.language_code ?? 'en',
    publication_name: o.publication_name ?? 'Pub',
    // No titles: shared title tokens would story-merge fixtures accidentally.
    title_en: o.title_en ?? null,
    title_original: o.title_original ?? null,
    description_en: o.description_en ?? null,
    article_url: o.article_url ?? null,
    image_url: o.image_url ?? null,
    userTopicIds: o.userTopicIds ?? [],
    createdAt: o.createdAt ?? new Date(NOW - H).toISOString(),
    firstPubDate: o.firstPubDate ?? new Date(NOW - H).toISOString(),
    rawScore: o.rawScore ?? 0.5,
    eventType: o.eventType ?? null,
    headlineScope: o.headlineScope ?? null,
    headlineCountryCode: o.headlineCountryCode ?? null,
    matchedTopics: o.matchedTopics ?? [],
    factIds: o.factIds ?? [],
    scoredAt: o.scoredAt ?? null,
  };
}

/** A top-headline row exactly as the sync persists one: a synthetic matched
 *  topic with a null topicId, plus the scope (and country, for COUNTRY). */
function headline(
  scope: 'COUNTRY' | 'GLOBAL' | 'CITY',
  countryCode: string | null,
  o: Partial<ForYouSuggestion> = {},
): ForYouSuggestion {
  return sugg({
    headlineScope: scope,
    headlineCountryCode: countryCode,
    matchedTopics: [{ topicId: null, text: `top headline · ${scope.toLowerCase()}` }],
    ...o,
  });
}

function snapshots(
  opts: {
    topics?: [string, { factId: string | null; weight?: number; status?: string }][];
    facts?: [string, { weight?: number | null; statement?: string }][];
    locations?: [string, { countryCode: string; weight: number }][];
  } = {},
): FactRowsSnapshots {
  return {
    topics: new Map(
      (opts.topics ?? []).map(([id, t]) => [
        id,
        {
          factId: t.factId,
          weight: t.weight ?? 0.8,
          highPriority: false,
          status: t.status ?? 'active',
        },
      ]),
    ),
    facts: new Map(
      (opts.facts ?? []).map(([id, f]) => [
        id,
        { weight: f.weight ?? 1, createdAtMs: 100, statement: f.statement ?? `Fact ${id}` },
      ]),
    ),
    locations: new Map(
      (opts.locations ?? []).map(([id, l]) => [
        id,
        { city: null, region: null, countryCode: l.countryCode, country: null, weight: l.weight },
      ]),
    ),
    factStatements: new Map(),
  };
}

const build = (s: ForYouSuggestion[], snaps = snapshots()) =>
  buildFactRows(s, snaps, new Set(), NOW, DEFAULT_HARNESS_CONFIG);

const COUNTRY_IN_SECTION = 'headline-country-in';
const COUNTRY_NL_SECTION = 'headline-country-nl';

describe('headline sections — a headline row now reaches a section', () => {
  it('a GLOBAL headline row gets a section instead of being dropped', () => {
    const { rows } = build([headline('GLOBAL', null)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].factId).toBe(GLOBAL_HEADLINE_SECTION_ID);
    expect(rows[0].kind).toBe('headline-global');
    expect(rows[0].groups).toHaveLength(1);
  });

  it('a headline row still resolves to NO owning fact (the old drop reason)', () => {
    // Sanity: the row has only synthetic (null-topicId) matches, so nothing
    // about fact ownership changed — it is the FALLTHROUGH that is new.
    const { rows } = build([headline('COUNTRY', 'IN')], snapshots({
      topics: [['t1', { factId: 'f1' }]],
      facts: [['f1', {}]],
    }));
    expect(rows.map((r) => r.factId)).toEqual([COUNTRY_IN_SECTION]);
  });

  it('CITY scope has no section (never requested as its own retrieval scope)', () => {
    const { rows } = build([headline('CITY', null)]);
    expect(rows).toHaveLength(0);
  });
});

describe('headline sections — country / GLOBAL split', () => {
  it('splits one section per country code plus one GLOBAL section', () => {
    const { rows } = build([
      headline('COUNTRY', 'IN'),
      headline('COUNTRY', 'IN'),
      headline('COUNTRY', 'NL'),
      headline('GLOBAL', null),
    ]);
    const byId = new Map(rows.map((r) => [r.factId, r]));
    expect([...byId.keys()].sort()).toEqual(
      [COUNTRY_IN_SECTION, COUNTRY_NL_SECTION, GLOBAL_HEADLINE_SECTION_ID].sort(),
    );
    expect(byId.get(COUNTRY_IN_SECTION)!.groups).toHaveLength(2);
    expect(byId.get(COUNTRY_IN_SECTION)!.countryCode).toBe('IN');
    expect(byId.get(COUNTRY_IN_SECTION)!.kind).toBe('headline-country');
    expect(byId.get(COUNTRY_NL_SECTION)!.groups).toHaveLength(1);
    expect(byId.get(GLOBAL_HEADLINE_SECTION_ID)!.countryCode).toBeNull();
  });

  it('normalizes the country code, so one country is never split in two', () => {
    const { rows } = build([
      headline('COUNTRY', 'IN'),
      headline('COUNTRY', ' in '),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].factId).toBe(COUNTRY_IN_SECTION);
    expect(rows[0].groups).toHaveLength(2);
  });

  it('a fact section still owns a headline row that ALSO matched a real topic', () => {
    // Fact ownership wins over the scope fallback — otherwise the same card
    // would render in two sections.
    const dual = headline('COUNTRY', 'IN', {
      matchedTopics: [
        { topicId: null, text: 'top headline · country' },
        { topicId: 't1', text: 'dutch tax' },
      ],
    });
    const { rows } = build([dual], snapshots({
      topics: [['t1', { factId: 'f1' }]],
      facts: [['f1', { statement: 'Lives in NL' }]],
    }));
    const fact = rows.find((r) => r.factId === 'f1');
    const country = rows.find((r) => r.factId === COUNTRY_IN_SECTION);
    expect(fact!.groups).toHaveLength(1);
    // CONSCIOUSLY UPDATED IN P8 — this assertion was inverted on purpose; it is
    // not a silenced regression.
    //
    // It used to read: the country section still EXISTS with
    // headlineReadCount === 1 and zero cards. P8's product decision changed
    // exactly that. A co-matched headline is DELIBERATELY shown under the topic
    // it matched (more personal, and the pre-existing placement), which means it
    // can never appear in a headline section — so it must not inflate a
    // denominator for a population that section has no way to show. The whole
    // pool here is that one co-matched row, so the scope's denominator is 0 and
    // its section is not created at all: a section reading "Mera read 0
    // headlines" is a promise of content plus an admission there is none.
    //
    // Placement is UNCHANGED — the card still lives in the fact section above,
    // and is still never rendered twice.
    expect(country).toBeUndefined();
  });
});

describe('headline sections — the relevance bar is the EXISTING one', () => {
  it('RULE 1: a sub-discardFloor row is not a member (but was still read)', () => {
    const { rows } = build([
      headline('GLOBAL', null, { relevance: REL_UNSCORED }),
      headline('GLOBAL', null, { relevance: REL_MEDIUM }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].groups).toHaveLength(1);
    expect(rows[0].groups[0].bucket).toBe('MEDIUM');
    expect(rows[0].headlineReadCount).toBe(2);
  });

  // headlines P9 — conscious reversal. This asserted that an all-LOW section
  // KEPT its shell and showed no cards, on the argument that the denominator
  // ("Mera read 2 · none looked relevant today") was the only place the reader
  // learns Mera did the work. The user overruled it: an empty section promises
  // content and then admits it has none, costing a screenful each time. Their
  // standing rule — "if not relevant we're saving users time by not showing it"
  // — now applies to headline sections exactly as it always did to fact ones.
  it('RULE 2: an all-LOW section is dropped entirely, like a fact section', () => {
    const { rows } = build([
      headline('COUNTRY', 'IN', { relevance: REL_LOW }),
      headline('COUNTRY', 'IN', { relevance: REL_LOW }),
    ]);
    expect(rows).toHaveLength(0);
  });

  it('RULE 2: one MEDIUM member keeps the whole section, LOW members included', () => {
    const { rows } = build([
      headline('COUNTRY', 'IN', { relevance: REL_LOW }),
      headline('COUNTRY', 'IN', { relevance: REL_MEDIUM }),
    ]);
    expect(rows[0].groups).toHaveLength(2);
  });

  // headlines P9 — conscious reversal. This existed to pin the ASYMMETRY (fact
  // section vanishes, headline section keeps a shell). There is no asymmetry
  // any more, so it now pins the opposite: both kinds vanish together on the
  // same all-LOW membership. Kept rather than deleted because a future change
  // that reintroduces an empty-shell state for either kind should fail here.
  it('a FACT and a HEADLINE section with all-LOW membership BOTH disappear', () => {
    const { rows } = build(
      [
        sugg({ relevance: REL_LOW, matchedTopics: [{ topicId: 't1', text: 'dutch tax' }] }),
        headline('GLOBAL', null, { relevance: REL_LOW }),
      ],
      snapshots({ topics: [['t1', { factId: 'f1' }]], facts: [['f1', {}]] }),
    );
    expect(rows).toHaveLength(0);
  });
});

describe('headline sections — a COUNTRY row with no country', () => {
  it('belongs to no country section and invents no bucket', () => {
    const { rows } = build([
      headline('COUNTRY', null),
      headline('COUNTRY', ''),
    ]);
    expect(rows).toHaveLength(0);
  });

  it('does not contaminate a real country section or the GLOBAL one', () => {
    const { rows } = build([
      headline('COUNTRY', null),
      headline('COUNTRY', 'IN'),
      headline('GLOBAL', null),
    ]);
    const byId = new Map(rows.map((r) => [r.factId, r]));
    expect([...byId.keys()].sort()).toEqual(
      [COUNTRY_IN_SECTION, GLOBAL_HEADLINE_SECTION_ID].sort(),
    );
    expect(byId.get(COUNTRY_IN_SECTION)!.headlineReadCount).toBe(1);
    expect(byId.get(GLOBAL_HEADLINE_SECTION_ID)!.headlineReadCount).toBe(1);
  });
});

describe('headline sections — the denominator counts', () => {
  it('counts every in-window headline for the scope, cleared bar or not', () => {
    const { rows } = build([
      headline('GLOBAL', null, { relevance: REL_MEDIUM }),
      headline('GLOBAL', null, { relevance: REL_MEDIUM }),
      headline('GLOBAL', null, { relevance: REL_LOW }),
      headline('GLOBAL', null, { relevance: REL_UNSCORED }), // Rule 1 rejects
      // Never even reached the render gate / is still awaiting its note — Mera
      // read it all the same.
      headline('GLOBAL', null, { relevance: 0.1 }),
      headline('GLOBAL', null, { status: ArticleSuggestionStatus.ReasonPending }),
    ]);
    expect(rows[0].headlineReadCount).toBe(6);
    // shown = the cards that render: the two MEDIUMs + the LOW they carry.
    expect(rows[0].groups).toHaveLength(3);
  });

  it('excludes headlines outside the publication window from BOTH numbers', () => {
    const { rows } = build([
      headline('GLOBAL', null),
      headline('GLOBAL', null, { firstPubDate: new Date(NOW - 72 * H).toISOString() }),
    ]);
    expect(rows[0].headlineReadCount).toBe(1);
    expect(rows[0].groups).toHaveLength(1);
  });

  // headlines P9 — both of these previously asserted a surviving zero-card
  // shell. Empty sections are now dropped, and these two are the cases where
  // that is most clearly RIGHT: the only member that cleared the bar was
  // promoted to the breaking strip, so the story is still on screen, directly
  // above. Keeping the section would render an empty "Headlines from X" under a
  // strip already showing its one story.
  it('drops the section when its only qualifying member was promoted to breaking', () => {
    const { rows } = build([
      headline('COUNTRY', 'IN', { relevance: REL_UNSCORED }),
      headline('COUNTRY', 'IN', { relevance: REL_UNSCORED }),
      headline('COUNTRY', 'IN', { relevance: REL_MEDIUM, rawScore: 2 }), // → breaking
    ]);
    expect(rows).toHaveLength(0);
  });

  it('a breaking headline is shown in the strip and leaves no empty section behind', () => {
    const { breaking, rows } = build([headline('GLOBAL', null, { rawScore: 2 })]);
    expect(breaking).toHaveLength(1);
    expect(rows).toHaveLength(0);
  });

  it('fact sections carry no denominator', () => {
    const { rows } = build(
      [sugg({ matchedTopics: [{ topicId: 't1', text: 'dutch tax' }] })],
      snapshots({ topics: [['t1', { factId: 'f1' }]], facts: [['f1', {}]] }),
    );
    expect(rows[0].kind).toBe('fact');
    expect(rows[0].headlineReadCount).toBeUndefined();
  });
});

describe('headline sections — ordering on the shared weight axis', () => {
  it('default-weight fact > full-weight country (0.55) > GLOBAL (0.35)', () => {
    const { rows } = build(
      [
        sugg({ matchedTopics: [{ topicId: 't1', text: 'dutch tax' }] }),
        headline('COUNTRY', 'IN'),
        headline('GLOBAL', null),
      ],
      snapshots({
        topics: [['t1', { factId: 'f1' }]],
        facts: [['f1', {}]],
        locations: [['l1', { countryCode: 'IN', weight: 1 }]],
      }),
    );
    expect(rows.map((r) => r.factId)).toEqual([
      'f1',
      COUNTRY_IN_SECTION,
      GLOBAL_HEADLINE_SECTION_ID,
    ]);
    expect(rows[1].weight).toBeCloseTo(0.55);
    expect(rows[2].weight).toBeCloseTo(0.35);
  });

  it('a down-weighted fact section sinks below a full-weight country section', () => {
    const { rows } = build(
      [
        sugg({ matchedTopics: [{ topicId: 't1', text: 'dutch tax' }] }),
        headline('COUNTRY', 'IN'),
      ],
      snapshots({
        topics: [['t1', { factId: 'f1' }]],
        facts: [['f1', { weight: 0.4 }]],
        locations: [['l1', { countryCode: 'IN', weight: 1 }]],
      }),
    );
    expect(rows.map((r) => r.factId)).toEqual([COUNTRY_IN_SECTION, 'f1']);
  });

  it('a country section scales with the strongest location weight in it', () => {
    const { rows } = build(
      [headline('COUNTRY', 'IN'), headline('COUNTRY', 'NL')],
      snapshots({
        locations: [
          ['l1', { countryCode: 'IN', weight: 0.3 }],
          ['l2', { countryCode: 'NL', weight: 0.6 }],
          ['l3', { countryCode: 'NL', weight: 0.9 }],
        ],
      }),
    );
    expect(rows.map((r) => r.factId)).toEqual([COUNTRY_NL_SECTION, COUNTRY_IN_SECTION]);
    expect(rows[0].weight).toBeCloseTo(0.55 * 0.9);
    expect(rows[1].weight).toBeCloseTo(0.55 * 0.3);
  });

  it('a country with no surviving location falls back to full strength', () => {
    const { rows } = build([headline('COUNTRY', 'IN')]);
    expect(rows[0].weight).toBeCloseTo(0.55);
  });
});

// ---------------------------------------------------------------------------
// P8 site 4 — the denominator counts only rows that could land in the section
// ---------------------------------------------------------------------------
//
// A CO-MATCHED headline (one that also matched a real persona topic) carries a
// real topicId, resolves an owning fact, and is routed to that FACT's section
// at step 4 — it can never appear in a headline section. It was nevertheless
// counted in "Mera read N headlines", so the sentence described a population
// the section had no way to show. Placement is deliberately unchanged; only the
// denominator moved.

/** A headline that ALSO matched a real persona topic — the co-matched shape. */
function coMatchedHeadline(
  scope: 'COUNTRY' | 'GLOBAL',
  countryCode: string | null,
  topicId: string,
  o: Partial<ForYouSuggestion> = {},
): ForYouSuggestion {
  return sugg({
    headlineScope: scope,
    headlineCountryCode: countryCode,
    matchedTopics: [
      { topicId: null, text: `top headline · ${scope.toLowerCase()}` },
      { topicId, text: 'a real persona topic' },
    ],
    ...o,
  });
}

const OWNED = snapshots({
  topics: [['t1', { factId: 'f1' }]],
  facts: [['f1', { statement: 'Follows Dutch tax policy' }]],
});

describe('headline denominator — co-matched rows excluded (P8 site 4)', () => {
  it('does not count a co-matched headline that a fact owns', () => {
    const { rows } = build(
      [headline('GLOBAL', null), coMatchedHeadline('GLOBAL', null, 't1')],
      OWNED,
    );

    const global = rows.find((r) => r.factId === GLOBAL_HEADLINE_SECTION_ID);
    // Two GLOBAL headline rows in the pool, but only the PURE one can land here.
    expect(global!.headlineReadCount).toBe(1);
  });

  it('the co-matched row is still shown — under its fact, exactly as before', () => {
    const { rows } = build(
      [headline('GLOBAL', null), coMatchedHeadline('GLOBAL', null, 't1')],
      OWNED,
    );

    const fact = rows.find((r) => r.factId === 'f1');
    expect(fact!.kind).toBe('fact');
    expect(fact!.groups).toHaveLength(1);
    // …and it is NOT duplicated into the headline section.
    const global = rows.find((r) => r.factId === GLOBAL_HEADLINE_SECTION_ID);
    expect(global!.groups).toHaveLength(1);
    expect(global!.groups[0].data._id).not.toBe(fact!.groups[0].data._id);
  });

  it('a headline whose only matched topic is SUPPRESSED is still counted', () => {
    // Suppressed ⇒ resolver returns null ⇒ step 4 falls through to the headline
    // section, so the row genuinely belongs to this scope's accounting.
    const suppressed = snapshots({
      topics: [['t1', { factId: 'f1', weight: -0.9, status: 'active' }]],
      facts: [['f1', {}]],
    });
    const { rows } = build([coMatchedHeadline('GLOBAL', null, 't1')], suppressed);

    const global = rows.find((r) => r.factId === GLOBAL_HEADLINE_SECTION_ID);
    expect(global!.headlineReadCount).toBe(1);
  });

  it('a scope whose every headline is co-matched gets no section at all', () => {
    const { rows } = build([coMatchedHeadline('COUNTRY', 'IN', 't1')], OWNED);

    expect(rows.find((r) => r.factId === COUNTRY_IN_SECTION)).toBeUndefined();
  });
});

// The verification that matters: a pure headline must survive all the way to a
// RENDERED CARD, not merely into rows[]. The operative bars are 0.4
// (isSectionMemberEligible, step 4) and 0.6 (isFactSectionViable, step 5b) —
// NOT the 0.3 render gate. A test asserting only "the row reached rows[]"
// passes on the empty-shell case and proves nothing.
describe('headline section — end-to-end to a rendered card', () => {
  it('a pure headline at MEDIUM clears BOTH bars and produces a card', () => {
    const { rows } = build([headline('GLOBAL', null, { relevance: REL_MEDIUM })]);

    const global = rows.find((r) => r.factId === GLOBAL_HEADLINE_SECTION_ID);
    expect(global!.headlineReadCount).toBe(1);
    expect(global!.groups).toHaveLength(1); // a real card, not an empty shell
  });

  // headlines P9 — both previously asserted a surviving zero-card shell. The
  // user's decision is that a section with no cards is hidden, so the whole
  // section is now absent in both cases. These two are the end-to-end proof
  // that the ONLY thing which puts a headline section on screen is a member
  // that actually cleared both bars.
  it('a pure headline BELOW discardFloor produces no section at all', () => {
    const { rows } = build([headline('GLOBAL', null, { relevance: REL_UNSCORED })]);

    expect(rows.find((r) => r.factId === GLOBAL_HEADLINE_SECTION_ID)).toBeUndefined();
  });

  it('a pure headline at LOW only (0.4–0.6) is section-eligible but not viable, so no section', () => {
    const { rows } = build([headline('GLOBAL', null, { relevance: REL_LOW })]);

    expect(rows.find((r) => r.factId === GLOBAL_HEADLINE_SECTION_ID)).toBeUndefined();
  });
});
