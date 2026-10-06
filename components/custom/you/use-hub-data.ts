// The Profile hub's card data, one small hook per card. Each reads the same
// source as the screen its "View all" opens, so a card never disagrees with
// the screen behind it.

import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import type Location from '@/lib/database/models/Location';
import type PersonaChangeLogModel from '@/lib/database/models/PersonaChangeLog';
import type UserPublicationSubscriptionModel from '@/lib/database/models/UserPublicationSubscription';
import { getRenderableArticleCountByTopicTexts } from '@/lib/database/services/article-suggestion-service';
import { observeFacts } from '@/lib/database/services/fact-service';
import { getPendingCount, getPendingProposals, subscribeHygieneChange } from '@/lib/database/services/hygiene-service';
import { observeAll as observeAllLocations } from '@/lib/database/services/location-service';
import { observeRecent } from '@/lib/database/services/persona-change-log-service';
import { observeByFact } from '@/lib/database/services/topic-service';
import { observeActive as observeActiveSubscriptions } from '@/lib/database/services/user-publication-subscription-service';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { useFloatingChatFactMutationVersion } from '@/lib/stores/floating-chat-store';
import { useForYouStore } from '@/lib/stores/for-you-store';

/** Newest first, and `id` breaks a tie: two facts saved from one card can
 *  share a millisecond, and "the first three" must not change between reads. */
export function orderFacts(facts: readonly Fact[]): Fact[] {
    return [...facts].sort((a, b) => {
        const d = Date.parse(b.createdAt) - Date.parse(a.createdAt);
        return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/** As FactsList: stop showing "Counting" after this. Not imported from there,
 *  which would pull the swipeable list (Reanimated) into every hub reader. */
const COUNTS_TIME_LIMIT_MS = 8_000;

export type CountState = 'counting' | 'ready' | 'unavailable';

/**
 * Facts, newest first, plus the renderable article count per topic text (the
 * same source FactsList uses: only rows For You can show). Counts have no
 * observable, so they are re-read on focus, when a feed run finishes and when
 * a chat changed facts. Never a 0 for "not counted yet".
 */
export function useHubFacts(): {
    readonly facts: readonly Fact[] | null;
    readonly counts: Map<string, number>;
    readonly countState: CountState;
} {
    const [facts, setFacts] = useState<readonly Fact[] | null>(null);
    const [counts, setCounts] = useState<Map<string, number>>(new Map());
    const [countState, setCountState] = useState<CountState>('counting');
    const loaded = useRef(false);

    useEffect(() => {
        const sub = observeFacts().subscribe((rows) => setFacts(orderFacts(rows)));
        return () => sub.unsubscribe();
    }, []);

    const reload = useCallback(async () => {
        try {
            const next = await getRenderableArticleCountByTopicTexts();
            loaded.current = true;
            setCounts(next);
            setCountState('ready');
        } catch {
            if (!loaded.current) setCountState('unavailable');
        }
    }, []);

    useEffect(() => {
        const timer = setTimeout(() => {
            if (!loaded.current) setCountState('unavailable');
        }, COUNTS_TIME_LIMIT_MS);
        return () => clearTimeout(timer);
    }, []);

    useFocusEffect(
        useCallback(() => {
            void reload();
        }, [reload]),
    );
    const lastRunFinishedAt = useForYouStore((s) => s.lastProcessingRunFinishedAt);
    const factMutationVersion = useFloatingChatFactMutationVersion();
    useEffect(() => {
        if (lastRunFinishedAt || factMutationVersion > 0) void reload();
    }, [lastRunFinishedAt, factMutationVersion, reload]);

    return { facts, counts, countState };
}

/** A fact's live, active topic texts (the topics table, as FactAccordion reads). */
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

export function useHubCleanup(): { readonly count: number; readonly firstSummary: string | null } {
    const [state, setState] = useState<{ count: number; firstSummary: string | null }>({ count: 0, firstSummary: null });
    const refresh = useCallback(() => {
        Promise.all([getPendingCount(), getPendingProposals()])
            .then(([count, proposals]) => setState({ count, firstSummary: proposals[0]?.summary ?? null }))
            .catch(() => { /* keep the last state */ });
    }, []);
    useFocusEffect(
        useCallback(() => {
            refresh();
            return subscribeHygieneChange(refresh);
        }, [refresh]),
    );
    return state;
}

export function useHubSubscriptions(): readonly UserPublicationSubscriptionModel[] {
    const [rows, setRows] = useState<readonly UserPublicationSubscriptionModel[]>([]);
    useEffect(() => {
        const sub = observeActiveSubscriptions().subscribe(setRows);
        return () => sub.unsubscribe();
    }, []);
    return rows;
}

export function useHubActivity(limit: number): readonly PersonaChangeLogModel[] {
    const [rows, setRows] = useState<readonly PersonaChangeLogModel[]>([]);
    useEffect(() => {
        const sub = observeRecent(limit).subscribe(setRows);
        return () => sub.unsubscribe();
    }, [limit]);
    return rows;
}
