import {
    GroupableItem,
    StoryGroupingOptions,
    TITLE_JACCARD_DISPLAY_THRESHOLD,
    TITLE_JACCARD_PROPAGATION_THRESHOLD,
    CLUSTER_CORE_CONFIDENCE_THRESHOLD,
    WEIGHTED_JACCARD_DISPLAY_THRESHOLD,
    normalizeTitleTokens,
    titleJaccard,
    weightedTitleJaccard,
    buildStoryGroups,
    pickRepresentative,
} from '../story-grouping';

type ClusterMembership = { clusterId: string; confidence: number };

interface TestItem extends GroupableItem {
    id: string;
    title: string | null;
    clusters: ClusterMembership[];
}

function item(
    id: string,
    title: string | null,
    clusters: ClusterMembership[] = [],
): TestItem {
    return { id, title, clusters };
}

const DISPLAY_OPTS: StoryGroupingOptions = {
    titleJaccardThreshold: TITLE_JACCARD_DISPLAY_THRESHOLD,
    clusterConfidenceThreshold: CLUSTER_CORE_CONFIDENCE_THRESHOLD,
};

const PROPAGATION_OPTS: StoryGroupingOptions = {
    titleJaccardThreshold: TITLE_JACCARD_PROPAGATION_THRESHOLD,
    clusterConfidenceThreshold: CLUSTER_CORE_CONFIDENCE_THRESHOLD,
};

const DISPLAY_WEIGHTED_OPTS: StoryGroupingOptions = {
    titleJaccardThreshold: TITLE_JACCARD_DISPLAY_THRESHOLD,
    clusterConfidenceThreshold: CLUSTER_CORE_CONFIDENCE_THRESHOLD,
    weightedJaccardThreshold: WEIGHTED_JACCARD_DISPLAY_THRESHOLD,
};

/** True iff `x` and `y` land in the same group. */
function together(groups: TestItem[][], x: string, y: string): boolean {
    const g = groups.find((grp) => grp.some((m) => m.id === x));
    return !!g && g.some((m) => m.id === y);
}

/** Sort groups by their smallest member id and sort ids within, for
 *  order-insensitive assertions on membership. */
function groupIdSets(groups: TestItem[][]): string[][] {
    return groups
        .map((g) => g.map((it) => it.id).sort())
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// --- normalizeTitleTokens --------------------------------------------------

describe('normalizeTitleTokens', () => {
    it('lowercases and splits on punctuation', () => {
        const tokens = normalizeTitleTokens('Apple-Google: Merger, Announced!');
        expect(tokens).toEqual(new Set(['apple', 'google', 'merger', 'announced']));
    });

    it('drops tokens of length <= 2', () => {
        const tokens = normalizeTitleTokens('AI is on go car');
        // "ai", "is", "on", "go" are all <= 2 chars; only "car" survives.
        expect(tokens).toEqual(new Set(['car']));
    });

    it('drops English stopwords', () => {
        const tokens = normalizeTitleTokens('The report says new device will be released');
        // the/says/new/will/be dropped; report/device/released kept.
        expect(tokens).toEqual(new Set(['report', 'device', 'released']));
    });

    it('returns an empty set for null, undefined, empty, and whitespace', () => {
        expect(normalizeTitleTokens(null).size).toBe(0);
        expect(normalizeTitleTokens(undefined).size).toBe(0);
        expect(normalizeTitleTokens('').size).toBe(0);
        expect(normalizeTitleTokens('   ').size).toBe(0);
        expect(normalizeTitleTokens('!!! ,, ---').size).toBe(0);
    });

    it('deduplicates repeated tokens', () => {
        expect(normalizeTitleTokens('boom boom boom market')).toEqual(
            new Set(['boom', 'market']),
        );
    });
});

// --- titleJaccard ----------------------------------------------------------

describe('titleJaccard', () => {
    it('is 1 for identical non-empty sets', () => {
        const s = new Set(['alpha', 'beta', 'gamma']);
        expect(titleJaccard(s, new Set(s))).toBe(1);
    });

    it('is 0 for disjoint sets', () => {
        expect(titleJaccard(new Set(['a', 'b']), new Set(['c', 'd']))).toBe(0);
    });

    it('is 0 when both sets are empty', () => {
        expect(titleJaccard(new Set(), new Set())).toBe(0);
    });

    it('computes a known partial-overlap value', () => {
        // {a,b,c} vs {b,c,d,e}: intersection 2, union 5 → 0.4
        const a = new Set(['a', 'b', 'c']);
        const b = new Set(['b', 'c', 'd', 'e']);
        expect(titleJaccard(a, b)).toBeCloseTo(0.4, 10);
    });
});

// --- weightedTitleJaccard --------------------------------------------------

describe('weightedTitleJaccard', () => {
    it('is 0 when both sets are empty', () => {
        expect(weightedTitleJaccard(new Set(), new Set(), new Map(), 0)).toBe(0);
    });

    it('weights rare shared tokens above common ones', () => {
        // Corpus of 10 docs. "rare" appears in 2, "common" in 9.
        const df = new Map([['rare', 2], ['common', 9], ['x', 1], ['y', 1]]);
        const n = 10;
        // Pair 1 shares only the rare token; pair 2 shares only the common token.
        // Same structural overlap (1 shared, 1 unique each) → identical raw
        // Jaccard, but the rare-token pair must score strictly higher.
        const rareShared = weightedTitleJaccard(
            new Set(['rare', 'x']),
            new Set(['rare', 'y']),
            df,
            n,
        );
        const commonShared = weightedTitleJaccard(
            new Set(['common', 'x']),
            new Set(['common', 'y']),
            df,
            n,
        );
        expect(titleJaccard(new Set(['rare', 'x']), new Set(['rare', 'y']))).toBeCloseTo(
            titleJaccard(new Set(['common', 'x']), new Set(['common', 'y'])),
            10,
        );
        expect(rareShared).toBeGreaterThan(commonShared);
    });

    it('is 1 for identical single-token sets regardless of df', () => {
        const df = new Map([['solo', 5]]);
        expect(weightedTitleJaccard(new Set(['solo']), new Set(['solo']), df, 10)).toBeCloseTo(1, 10);
    });
});

// --- weighted title-edge grouping ------------------------------------------

describe('buildStoryGroups — weighted title edges', () => {
    // Two rare tokens (zephyr, qux) appear ONLY in the target pair; the rest of
    // each title is filler tokens made common by 10 filler docs. Raw Jaccard is
    // 0.25 (below the 0.4 bar) so only the IDF-weighted edge can merge them.
    const fillers = Array.from({ length: 10 }, (_, i) =>
        item(`f${i}`, `alpha beta gamma delta epsilon omega filler${i}word`),
    );
    const targetCorpus = [
        item('A', 'zephyr qux alpha beta gamma'),
        item('B', 'zephyr qux delta epsilon omega'),
        ...fillers,
    ];

    it('merges a same-story pair via the weighted edge when raw Jaccard is below the display bar', () => {
        expect(titleJaccard(normalizeTitleTokens('zephyr qux alpha beta gamma'), normalizeTitleTokens('zephyr qux delta epsilon omega'))).toBeLessThan(0.4);
        const groups = buildStoryGroups(targetCorpus, DISPLAY_WEIGHTED_OPTS);
        expect(together(groups, 'A', 'B')).toBe(true);
    });

    it('leaves the pair SEPARATE when the weighted option is absent', () => {
        const groups = buildStoryGroups(targetCorpus, DISPLAY_OPTS);
        expect(together(groups, 'A', 'B')).toBe(false);
    });

    it('does not merge the target pair into the common-token filler docs', () => {
        const groups = buildStoryGroups(targetCorpus, DISPLAY_WEIGHTED_OPTS);
        expect(together(groups, 'A', 'f0')).toBe(false);
    });

    it('merges the real Amsterdam-kidnapping pair via the weighted edge only', () => {
        // Raw Jaccard 0.333 (shared arrested/amsterdam/kidnapping/two), below 0.4.
        const aiFillers = Array.from({ length: 8 }, (_, i) =>
            item(`f${i}`, `Artificial Intelligence opinion piece number${i} about cognitive abilities and work`),
        );
        const corpus = [
            item('K1', 'Arrested suspects in Amsterdam kidnapping are two Rotterdammers'),
            item('K2', 'Kidnapping in Amsterdam-Oost: two men arrested, police fired warning shots'),
            ...aiFillers,
        ];
        expect(together(buildStoryGroups(corpus, DISPLAY_WEIGHTED_OPTS), 'K1', 'K2')).toBe(true);
        expect(together(buildStoryGroups(corpus, DISPLAY_OPTS), 'K1', 'K2')).toBe(false);
    });

    it('does NOT merge AI-opinion pieces that share only high-frequency topic tokens', () => {
        // The negative from calibration: distinct opinion pieces sharing only
        // ubiquitous "artificial"/"intelligence"/"cognitive"-class tokens must
        // stay separate even with the weighted edge on.
        const aiFillers = Array.from({ length: 8 }, (_, i) =>
            item(`f${i}`, `Artificial Intelligence opinion piece number${i} about cognitive abilities and work`),
        );
        const corpus = [
            item('O1', "AI Doesn't Take Work Away From Us"),
            item('O2', 'Does Using Artificial Intelligence Affect Human Cognitive Abilities'),
            ...aiFillers,
        ];
        const groups = buildStoryGroups(corpus, DISPLAY_WEIGHTED_OPTS);
        expect(together(groups, 'O1', 'O2')).toBe(false);
        expect(together(groups, 'O2', 'f0')).toBe(false);
    });
});

// --- title-edge grouping ---------------------------------------------------

describe('buildStoryGroups — title edges', () => {
    const OPENAI_A =
        "OpenAI's First Device Will Reportedly Be a Portable Smart Speaker";
    const OPENAI_B =
        'Report: OpenAI\'s first device will be a portable speaker with a camera and other sensors';
    const OPENAI_C =
        "OpenAI's First Consumer Device Will Be A Smart Speaker, Report Says";

    it('merges OpenAI-speaker headline variants at the 0.4 display threshold', () => {
        const items = [
            item('a', OPENAI_A),
            item('b', OPENAI_B),
            item('c', OPENAI_C),
        ];
        const groups = buildStoryGroups(items, DISPLAY_OPTS);
        expect(groupIdSets(groups)).toEqual([['a', 'b', 'c']]);
    });

    it('does not merge unrelated titles', () => {
        const items = [
            item('a', 'Amsterdam council approves new bicycle bridge plan'),
            item('b', 'Tokyo stock exchange closes higher amid yen rally'),
            item('c', 'Scientists discover new species of deep-sea coral'),
        ];
        const groups = buildStoryGroups(items, DISPLAY_OPTS);
        expect(groups).toHaveLength(3);
    });

    it('does NOT merge a 0.4-band pair at the 0.55 propagation threshold', () => {
        // OPENAI_A vs OPENAI_B Jaccard ≈ 0.45 — clears 0.4, below 0.55.
        const aTokens = normalizeTitleTokens(OPENAI_A);
        const bTokens = normalizeTitleTokens(OPENAI_B);
        const jac = titleJaccard(aTokens, bTokens);
        expect(jac).toBeGreaterThanOrEqual(0.4);
        expect(jac).toBeLessThan(0.55);

        const items = [item('a', OPENAI_A), item('b', OPENAI_B)];
        expect(buildStoryGroups(items, DISPLAY_OPTS)).toHaveLength(1);
        expect(buildStoryGroups(items, PROPAGATION_OPTS)).toHaveLength(2);
    });
});

// --- cluster-edge grouping -------------------------------------------------

describe('buildStoryGroups — cluster edges', () => {
    const ASML_A =
        'ASML further raises expectations after significant revenue and profit increase due to ongoing AI boom';
    const ASML_B =
        'AI Boom Drives Demand: Chip Manufacturer ASML Raises Forecast Again';

    it('the ASML paraphrase pair has low title overlap on its own', () => {
        const jac = titleJaccard(
            normalizeTitleTokens(ASML_A),
            normalizeTitleTokens(ASML_B),
        );
        expect(jac).toBeLessThan(0.35);
    });

    it('merges the ASML pair via a shared cluster at confidence 1.0', () => {
        const items = [
            item('a', ASML_A, [{ clusterId: 'c1', confidence: 1.0 }]),
            item('b', ASML_B, [{ clusterId: 'c1', confidence: 1.0 }]),
        ];
        expect(buildStoryGroups(items, DISPLAY_OPTS)).toHaveLength(1);
    });

    it('does NOT merge the ASML pair when shared cluster confidence is 0.0', () => {
        const items = [
            item('a', ASML_A, [{ clusterId: 'c1', confidence: 0.0 }]),
            item('b', ASML_B, [{ clusterId: 'c1', confidence: 0.0 }]),
        ];
        expect(buildStoryGroups(items, DISPLAY_OPTS)).toHaveLength(2);
    });
});

// --- cross-generation bridge ----------------------------------------------

describe('buildStoryGroups — cross-generation bridge', () => {
    it('bridges A–B (cluster edge) and B–C (title edge) into one group of 3', () => {
        const A = item('a', 'Quarterly earnings surprise investors greatly', [
            { clusterId: 'gen1', confidence: 1.0 },
        ]);
        const B = item(
            'b',
            'OpenAI portable smart speaker device reportedly',
            [{ clusterId: 'gen1', confidence: 1.0 }],
        );
        const C = item('c', 'OpenAI portable smart speaker device consumer', [
            { clusterId: 'gen2', confidence: 1.0 },
        ]);
        // A–B share cluster gen1; B–C share a high title Jaccard but different
        // clusterIds; A–C share nothing.
        const groups = buildStoryGroups([A, B, C], DISPLAY_OPTS);
        expect(groupIdSets(groups)).toEqual([['a', 'b', 'c']]);
    });
});

// --- blocking correctness --------------------------------------------------

describe('buildStoryGroups — blocking correctness', () => {
    it('finds a pair sharing exactly 2 tokens that clears the threshold', () => {
        // Two 4-token titles sharing exactly 2 tokens → Jaccard 2/6 ≈ 0.333.
        const items = [
            item('a', 'alpha beta orange purple'),
            item('b', 'alpha beta yellow silver'),
        ];
        const opts: StoryGroupingOptions = {
            titleJaccardThreshold: 0.3,
            clusterConfidenceThreshold: CLUSTER_CORE_CONFIDENCE_THRESHOLD,
        };
        expect(buildStoryGroups(items, opts)).toHaveLength(1);
    });

    it('applies the short-title relaxation (≤3 tokens, 1 shared token)', () => {
        // Two 2-token titles sharing exactly 1 token → Jaccard 1/3 ≈ 0.333.
        // Only reachable because the ≥2-shared candidate rule relaxes to ≥1 for
        // short titles.
        const items = [item('a', 'alpha beta'), item('b', 'alpha gamma')];
        const opts: StoryGroupingOptions = {
            titleJaccardThreshold: 0.3,
            clusterConfidenceThreshold: CLUSTER_CORE_CONFIDENCE_THRESHOLD,
        };
        expect(buildStoryGroups(items, opts)).toHaveLength(1);
    });
});

// --- edge cases ------------------------------------------------------------

describe('buildStoryGroups — edge cases', () => {
    it('returns [] for empty input', () => {
        expect(buildStoryGroups([], DISPLAY_OPTS)).toEqual([]);
    });

    it('emits singletons for items with null/empty titles and no clusters', () => {
        const items = [item('a', null), item('b', ''), item('c', '   ')];
        expect(buildStoryGroups(items, DISPLAY_OPTS)).toHaveLength(3);
    });

    it('still merges null-title items that share a high-confidence cluster', () => {
        const items = [
            item('a', null, [{ clusterId: 'c1', confidence: 1.0 }]),
            item('b', null, [{ clusterId: 'c1', confidence: 1.0 }]),
        ];
        expect(buildStoryGroups(items, DISPLAY_OPTS)).toHaveLength(1);
    });

    it('preserves input order within a group', () => {
        const items = [
            item('z', 'OpenAI portable smart speaker device reportedly'),
            item('m', 'OpenAI portable smart speaker device consumer'),
            item('a', 'OpenAI portable smart speaker device announced'),
        ];
        const groups = buildStoryGroups(items, DISPLAY_OPTS);
        expect(groups).toHaveLength(1);
        expect(groups[0].map((it) => it.id)).toEqual(['z', 'm', 'a']);
    });
});

// --- pickRepresentative ----------------------------------------------------

describe('pickRepresentative', () => {
    const byRelevanceDesc = (a: { relevance: number }, b: { relevance: number }) =>
        b.relevance - a.relevance;

    it('respects the comparator', () => {
        const group = [
            { ...item('a', 'A'), relevance: 0.2 },
            { ...item('b', 'B'), relevance: 0.9 },
            { ...item('c', 'C'), relevance: 0.5 },
        ];
        expect(pickRepresentative(group, byRelevanceDesc).id).toBe('b');
    });

    it('breaks comparator ties by lexicographically smaller id', () => {
        const group = [
            { ...item('m', 'M'), relevance: 0.5 },
            { ...item('a', 'A'), relevance: 0.5 },
            { ...item('z', 'Z'), relevance: 0.5 },
        ];
        expect(pickRepresentative(group, byRelevanceDesc).id).toBe('a');
    });

    it('throws on an empty group', () => {
        expect(() => pickRepresentative([], byRelevanceDesc)).toThrow();
    });
});

// --- scale + determinism ---------------------------------------------------

describe('buildStoryGroups — scale and determinism', () => {
    function synthesizeItems(): TestItem[] {
        const items: TestItem[] = [];
        // ~50 near-duplicate families of ~10 members each (500 items).
        const FAMILIES = 50;
        const PER_FAMILY = 10;
        for (let f = 0; f < FAMILIES; f += 1) {
            const base = [
                `topic${f}alpha`,
                `topic${f}beta`,
                `topic${f}gamma`,
                `topic${f}delta`,
                `topic${f}epsilon`,
            ];
            for (let k = 0; k < PER_FAMILY; k += 1) {
                // Each member drops one base token and adds a unique one — high
                // mutual overlap, comfortably above 0.4.
                const tokens = base.filter((_, idx) => idx !== k % base.length);
                tokens.push(`variant${f}x${k}`);
                items.push(item(`fam${f}_${k}`, tokens.join(' ')));
            }
        }
        // 1000 unique-noise titles that should never merge.
        for (let i = 0; i < 1000; i += 1) {
            items.push(item(`noise${i}`, `unique${i}word alpha${i}two beta${i}three`));
        }
        return items;
    }

    it('groups 1500 synthetic titles in under 1s', () => {
        const items = synthesizeItems();
        expect(items.length).toBe(1500);

        const start = Date.now();
        const groups = buildStoryGroups(items, DISPLAY_OPTS);
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(1000);
        // 50 family groups + 1000 noise singletons = 1050 groups.
        expect(groups).toHaveLength(1050);
    });

    it('is deterministic: same input yields the same groups', () => {
        const items = synthesizeItems();
        const a = groupIdSets(buildStoryGroups(items, DISPLAY_OPTS));
        const b = groupIdSets(buildStoryGroups(items, DISPLAY_OPTS));
        expect(a).toEqual(b);
    });
});
