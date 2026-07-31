// The three reactive lists behind "Not interested", in one place because two
// surfaces read them: the Advanced-hub row (which only needs `total`) and the
// NotInterestedScreen (which needs the rows). Keeping the expiry filter and the
// hard-first ordering here means the hub count and the screen can never
// disagree about what "hidden" means.

import { useEffect, useState } from 'react';

import type PersonaSuppressionModel from '@/lib/database/models/PersonaSuppression';
import type PublicationPreferenceModel from '@/lib/database/models/PublicationPreference';
import type TopicModel from '@/lib/database/models/Topic';
import { observeActive as observeActivePrefs } from '@/lib/database/services/publication-preference-service';
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
    /** Publication preferences the user pushed below zero (mute + downrank). */
    readonly mutedSources: readonly PublicationPreferenceModel[];
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
    const [mutedSources, setMutedSources] = useState<PublicationPreferenceModel[]>([]);
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
            observeActivePrefs().subscribe((rows) => {
                setMutedSources(rows.filter((p) => p.weight < 0));
                bumpOnce('sources');
            }),
        ];
        return () => subs.forEach((s) => s.unsubscribe());
    }, []);

    return {
        filters,
        topics,
        mutedSources,
        total: filters.length + topics.length + mutedSources.length,
        isLoading: settled < 3,
    };
}
