// The Profile page's data, one small hook per group. Each reads the same
// source as the screen its row opens, so Profile never disagrees with the
// screen behind it.

import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';

import type Location from '@/lib/database/models/Location';
import { observeFacts } from '@/lib/database/services/fact-service';
import { getPendingCount, subscribeHygieneChange } from '@/lib/database/services/hygiene-service';
import { observeAll as observeAllLocations } from '@/lib/database/services/location-service';
import { observeByFact } from '@/lib/database/services/topic-service';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';

/** Newest first, and `id` breaks a tie: two facts saved from one card can
 *  share a millisecond, and "the first two" must not change between reads. */
export function orderFacts(facts: readonly Fact[]): Fact[] {
    return [...facts].sort((a, b) => {
        const d = Date.parse(b.createdAt) - Date.parse(a.createdAt);
        return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/** Facts, newest first; null until the first read. */
export function useHubFacts(): readonly Fact[] | null {
    const [facts, setFacts] = useState<readonly Fact[] | null>(null);
    useEffect(() => {
        const sub = observeFacts().subscribe((rows) => setFacts(orderFacts(rows)));
        return () => sub.unsubscribe();
    }, []);
    return facts;
}

/** A fact's live, active topic texts (the topics table). */
export function useActiveTopicTexts(factId: string): readonly string[] {
    const [texts, setTexts] = useState<readonly string[]>([]);
    useEffect(() => {
        const sub = observeByFact(factId).subscribe((rows) =>
            setTexts(rows.filter((r) => r.status === 'active').map((r) => r.text)),
        );
        return () => sub.unsubscribe();
    }, [factId]);
    return texts;
}

export function useHubPlaces(): readonly Location[] | null {
    const [rows, setRows] = useState<readonly Location[] | null>(null);
    useEffect(() => {
        const sub = observeAllLocations().subscribe(setRows);
        return () => sub.unsubscribe();
    }, []);
    return rows;
}

/** How many cleanups wait, the same total the review screen shows. */
export function useHubCleanup(): { readonly count: number } {
    const [count, setCount] = useState(0);
    const refresh = useCallback(() => {
        getPendingCount()
            .then(setCount)
            .catch(() => { /* keep the last count */ });
    }, []);
    useFocusEffect(
        useCallback(() => {
            refresh();
            return subscribeHygieneChange(refresh);
        }, [refresh]),
    );
    return { count };
}
