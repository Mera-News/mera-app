// plan-recommendation (B6, Item 10) — verifies:
//  • null on thin history: fewer than 5 total visits, or a span under 14 days;
//  • both boundaries are inclusive (exactly 5 visits, exactly 14 days pass);
//  • the FIXED 14-day denominator, not however many distinct days were
//    actually observed;
//  • the cheapest-qualifying plan is picked (first in caller-given order
//    whose dailyArticleLimit clears avgDaily * 3);
//  • the most-generous-plan fallback when no plan clears the bar;
//  • null when there are no plans to recommend.

import { recommendPlan, type RecommendationPlan, type RecommendationVisit } from '../plan-recommendation';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed epoch ms for deterministic tests

const PLANS: RecommendationPlan[] = [
    { id: 'starter', name: 'Starter', dailyArticleLimit: 15 },
    { id: 'individual', name: 'Individual', dailyArticleLimit: 40 },
    { id: 'professional', name: 'Professional', dailyArticleLimit: 100 },
];

/** `count` visits spread one per day, most recent at `now`, going backward. */
function dailyVisits(count: number, now: number = NOW): RecommendationVisit[] {
    return Array.from({ length: count }, (_, i) => ({ visitedAt: now - i * DAY_MS }));
}

describe('recommendPlan', () => {
    it('returns null with fewer than 5 total visits', () => {
        const visits = dailyVisits(4);
        expect(recommendPlan(visits, PLANS, NOW)).toBeNull();
    });

    it('returns a recommendation at exactly 5 total visits (boundary)', () => {
        // Exactly 5 visits, with the earliest exactly 14 days back so the span
        // floor is also cleared — isolates the visits-count boundary (>=5
        // passes) from the span boundary, which is asserted separately below.
        const visits: RecommendationVisit[] = [
            { visitedAt: NOW },
            { visitedAt: NOW - 1 * DAY_MS },
            { visitedAt: NOW - 2 * DAY_MS },
            { visitedAt: NOW - 3 * DAY_MS },
            { visitedAt: NOW - MIN_HISTORY_MS() },
        ];
        expect(visits).toHaveLength(5);
        const result = recommendPlan(visits, PLANS, NOW);
        expect(result).not.toBeNull();
    });

    it('returns null when history spans fewer than 14 days, even with 5+ visits', () => {
        // 10 visits, one per day: span is 9 days — under the 14-day floor.
        const visits = dailyVisits(10);
        expect(recommendPlan(visits, PLANS, NOW)).toBeNull();
    });

    it('returns a recommendation at exactly a 14-day span (boundary)', () => {
        const fourteenDaysMs = MIN_HISTORY_MS();
        const visits: RecommendationVisit[] = [
            { visitedAt: NOW }, // 5 total visits, spaced across the window
            { visitedAt: NOW - 1 * DAY_MS },
            { visitedAt: NOW - 2 * DAY_MS },
            { visitedAt: NOW - 3 * DAY_MS },
            { visitedAt: NOW - fourteenDaysMs }, // earliest — exactly 14 days back
        ];
        const result = recommendPlan(visits, PLANS, NOW);
        expect(result).not.toBeNull();
    });

    it('returns null just under the 14-day span boundary', () => {
        const justUnder = MIN_HISTORY_MS() - 1;
        const visits: RecommendationVisit[] = [
            { visitedAt: NOW },
            { visitedAt: NOW - 1 * DAY_MS },
            { visitedAt: NOW - 2 * DAY_MS },
            { visitedAt: NOW - 3 * DAY_MS },
            { visitedAt: NOW - justUnder },
        ];
        expect(recommendPlan(visits, PLANS, NOW)).toBeNull();
    });

    it('divides by the FIXED 14-day denominator, not the number of distinct days observed', () => {
        // 14 visits packed into only 7 distinct days (2/day, days 0..6 — all
        // strictly inside the window, no boundary ambiguity). If the
        // denominator were "days observed" this would read 14/7 = 2;
        // avgDaily must instead read 14/14 = 1.
        const visits: RecommendationVisit[] = [];
        for (let day = 0; day < 7; day++) {
            visits.push({ visitedAt: NOW - day * DAY_MS });
            visits.push({ visitedAt: NOW - day * DAY_MS - 1000 });
        }
        visits.push({ visitedAt: NOW - 100 * DAY_MS }); // span-only, outside the window
        const result = recommendPlan(visits, PLANS, NOW);
        expect(result?.avgDaily).toBe(1);
    });

    it('excludes visits older than the trailing 14-day window from avgDaily', () => {
        // 14 recent visits, one per day for days 0..13 (all strictly inside
        // the window) plus 5 ancient ones far outside it. Total visits = 19
        // (>=5), span > 14 days. Only the 14 recent ones count.
        const recent: RecommendationVisit[] = Array.from({ length: 14 }, (_, i) => ({
            visitedAt: NOW - i * DAY_MS,
        }));
        const ancient: RecommendationVisit[] = Array.from({ length: 5 }, (_, i) => ({
            visitedAt: NOW - (100 + i) * DAY_MS,
        }));
        const visits = [...recent, ...ancient];
        const result = recommendPlan(visits, PLANS, NOW);
        expect(result?.avgDaily).toBe(1);
    });

    // Dense fixtures below split the SPAN requirement from the WINDOW count:
    // the dense visits only cover days 0..13 (14 distinct days, all strictly
    // inside the trailing-14-day window — no boundary ambiguity), and a single
    // extra ancient visit (day 100, well outside the window and irrelevant to
    // avgDaily) clears the 14-day span floor on its own.
    function denseVisitsPerDay(visitsPerDay: number): RecommendationVisit[] {
        const dense: RecommendationVisit[] = [];
        for (let day = 0; day < 14; day++) {
            for (let v = 0; v < visitsPerDay; v++) {
                dense.push({ visitedAt: NOW - day * DAY_MS - v * 1000 });
            }
        }
        dense.push({ visitedAt: NOW - 100 * DAY_MS }); // span-only, outside the window
        return dense;
    }

    it('picks the cheapest plan whose dailyArticleLimit clears avgDaily * 3', () => {
        // 14 days * 4 visits/day = 56 in the trailing window -> avgDaily = 4;
        // threshold = 12. Starter(15) already clears 12, so Starter (cheapest,
        // first in list) is picked.
        const result = recommendPlan(denseVisitsPerDay(4), PLANS, NOW);
        expect(result?.avgDaily).toBe(4);
        expect(result?.plan.id).toBe('starter');
    });

    it('skips a plan that does not clear the threshold and picks the next cheapest that does', () => {
        // avgDaily = 6/day -> threshold = 18. Starter(15) does not clear it;
        // Individual(40) does.
        const result = recommendPlan(denseVisitsPerDay(6), PLANS, NOW);
        expect(result?.avgDaily).toBe(6);
        expect(result?.plan.id).toBe('individual');
    });

    it('falls back to the most generous plan when no plan clears the threshold', () => {
        // avgDaily = 40/day -> threshold = 120, above every plan's limit
        // (max 100). Falls back to Professional (highest dailyArticleLimit).
        const result = recommendPlan(denseVisitsPerDay(40), PLANS, NOW);
        expect(result?.avgDaily).toBe(40);
        expect(result?.plan.id).toBe('professional');
    });

    it('fallback picks the most generous plan even when the list is not price-sorted', () => {
        // Reduce must not just take the LAST plan — the middle one (50) is the
        // most generous even though a smaller one (10) follows it.
        const unsorted: RecommendationPlan[] = [
            { id: 'a', name: 'A', dailyArticleLimit: 5 },
            { id: 'b', name: 'B', dailyArticleLimit: 50 },
            { id: 'c', name: 'C', dailyArticleLimit: 10 },
        ];
        const result = recommendPlan(denseVisitsPerDay(1000), unsorted, NOW);
        expect(result?.plan.id).toBe('b');
    });

    it('returns null when there are no plans to recommend', () => {
        const visits = [
            { visitedAt: NOW },
            { visitedAt: NOW - 1 * DAY_MS },
            { visitedAt: NOW - 2 * DAY_MS },
            { visitedAt: NOW - 3 * DAY_MS },
            { visitedAt: NOW - MIN_HISTORY_MS() },
        ];
        expect(recommendPlan(visits, [], NOW)).toBeNull();
    });

    it('defaults `now` to Date.now() when omitted', () => {
        const realNow = Date.now();
        const visits: RecommendationVisit[] = [
            { visitedAt: realNow },
            { visitedAt: realNow - 1 * DAY_MS },
            { visitedAt: realNow - 2 * DAY_MS },
            { visitedAt: realNow - 3 * DAY_MS },
            { visitedAt: realNow - MIN_HISTORY_MS() },
        ];
        expect(recommendPlan(visits, PLANS)).not.toBeNull();
    });
});

function MIN_HISTORY_MS(): number {
    return 14 * DAY_MS;
}
