import {
    GroupableItem,
    StoryGroupingOptions,
    TITLE_JACCARD_DISPLAY_THRESHOLD,
    TITLE_JACCARD_PROPAGATION_THRESHOLD,
    CLUSTER_CORE_CONFIDENCE_THRESHOLD,
    normalizeTitleTokens,
    titleJaccard,
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
