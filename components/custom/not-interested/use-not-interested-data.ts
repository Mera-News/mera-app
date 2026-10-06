// The two reactive lists behind "Not interested" (filters and turned-down
// topics), in one place because two surfaces read them: the Profile hub's
// "Topics you turned down" card and NotInterestedScreen. Keeping the expiry
// filter and the hard-first ordering here means the card and the screen can
// never disagree about what "hidden" means. Muted and downranked sources are
// NOT here: they live on the Sources screen (use-adjusted-sources).

import { useEffect, useState } from 'react';

import type PersonaSuppressionModel from '@/lib/database/models/PersonaSuppression';
import type TopicModel from '@/lib/database/models/Topic';
import {
    HARD_SUPPRESSION_STRENGTH,
    observeActive as observeActiveSuppressions,
} from '@/lib/database/services/suppression-service';
import { observeNegative as observeNegativeTopics } from '@/lib/database/services/topic-service';

export interface NotInterestedData {
    /** Active, NON-EXPIRED suppressions, hard filters first. */
    readonly filters: readonly PersonaSuppressionModel[];
    /** Negative-weight or suppressed topics, most negative first. */
    readonly topics: readonly TopicModel[];
    readonly total: number;
    readonly isLoading: boolean;
}

/**
 * `observeActive()` deliberately does NO expiry filtering — that is the
 * consumer's job (a soft suppression stays `active` in the DB and simply stops
 * counting once `expires_at` passes). Evaluated per emission, not once at
 * subscribe time, so a list that is open across an expiry boundary corrects
 * itself on the next change.
 */
function liveFilters(rows: PersonaSuppressionModel[]): PersonaSuppressionModel[] {
    const now = Date.now();
    return rows
        .filter((s) => s.expiresAt == null || s.expiresAt > now)
        .sort((a, b) => {
            const aHard = a.strength >= HARD_SUPPRESSION_STRENGTH ? 1 : 0;
            const bHard = b.strength >= HARD_SUPPRESSION_STRENGTH ? 1 : 0;
            if (aHard !== bHard) return bHard - aHard;
            return b.createdAt.getTime() - a.createdAt.getTime();
        });
}

export function useNotInterestedData(): NotInterestedData {
    const [filters, setFilters] = useState<PersonaSuppressionModel[]>([]);
    const [topics, setTopics] = useState<TopicModel[]>([]);
    const [settled, setSettled] = useState(0);

    useEffect(() => {
        let seen = 0;
        const bumpOnce = (() => {
            const fired = new Set<string>();
            return (key: string) => {
                if (fired.has(key)) return;
                fired.add(key);
                seen += 1;
                setSettled(seen);
            };
        })();

        const subs = [
            observeActiveSuppressions().subscribe((rows) => {
                setFilters(liveFilters(rows));
                bumpOnce('filters');
            }),
            observeNegativeTopics().subscribe((rows) => {
                setTopics(rows);
                bumpOnce('topics');
            }),
        ];
        return () => subs.forEach((s) => s.unsubscribe());
    }, []);

    return {
        filters,
        topics,
        total: filters.length + topics.length,
        isLoading: settled < 2,
    };
}
