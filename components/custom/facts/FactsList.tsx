import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { authClient } from '@/lib/auth-client';
import { getRenderableArticleCountByTopicTexts } from '@/lib/database/services/article-suggestion-service';
import { deleteFact, getFacts, observeFacts } from '@/lib/database/services/fact-service';
import { enqueueJob } from '@/lib/database/services/inference-job-service';
import { deleteTopicWithDecline } from '@/lib/database/services/topic-decline-service';
import { createTopics, syncLlmTopicsForFact } from '@/lib/database/services/topic-service';
import { buildTopicGenContext } from '@/lib/inference/handlers/topic-gen-handler';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import logger from '@/lib/logger';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { generateTopicsForFact } from '@/lib/mera-protocol/topic-generation-service';
import { useFloatingChatFactMutationVersion, useFloatingChatIsExpanded } from '@/lib/stores/floating-chat-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useIsOnDeviceProcessing } from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
import { router, useFocusEffect } from 'expo-router';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AddTopicModal from './AddTopicModal';
import DeleteFactModal from './DeleteFactModal';
import FactAccordion, { type ArticleCountState } from './FactAccordion';
import GenerateMoreModal from './GenerateMoreModal';

const GENERATE_MORE_TOPIC_COUNT = 10;

/** "Counting" never stays up longer than this: a slow or failed read hides the
 *  counts instead of showing a spinner-in-words forever, or a false 0. */
export const COUNTS_TIME_LIMIT_MS = 8000;

/** Imperative handle so a parent screen's own pull-to-refresh (RefreshControl)
 *  can force-reload the facts data this component owns internally. */
export interface FactsListHandle {
    refresh: () => Promise<void>;
}

interface FactsListProps {
    /** Fired with `null` while the initial load is in flight, then with the
     *  current facts array on every load/reload — lets a host screen (e.g.
     *  FactsScreen) drive its own full-page loading/empty chrome without
     *  duplicating the fact-loading logic. Purely optional — ProfileScreen
     *  doesn't need it since it already gates visibility via its own
     *  fact-count check. */
    readonly onFactsChange?: (facts: Fact[] | null) => void;
    /** Edit mode: delete controls on, expansion off (F46). */
    readonly editing?: boolean;
}

/**
 * The interactive facts list — one `FactAccordion` row per fact (delete,
 * N-articles pill, chevron expand → topics with per-topic delete/add/generate-
 * more). Extracted verbatim from `FactsScreen` (Wave r6b) so `ProfileScreen`
 * can render the same real facts list instead of the old persona-summary
 * strings. Fully self-contained — owns its own data loading, expansion,
 * delete, and topic-management state/handlers; a host screen only needs to
 * mount it (optionally wiring `onFactsChange`/a ref for its own loading/empty
 * chrome and pull-to-refresh).
 */
const FactsList = forwardRef<FactsListHandle, FactsListProps>(({ onFactsChange, editing = false }, ref) => {
    // Identity is a LOCAL fact (lib/security/launch-route.ts). Every mutation
    // below writes to the on-device DB; the id is wanted only for the persona
    // refresh that follows. Read off the server session it went undefined
    // whenever /get-session could not be reached — offline, a keychain-locked
    // background wake, a 401 blip — and the `!userId` guards then froze the
    // user out of their own facts: delete, add-topic and the post-chat reload
    // all silently returned. The persisted id survives that; the session is the
    // fallback for the window before hydrateFromDb() has run.
    const { data: session } = authClient.useSession();
    const localUserId = useUserStore((s) => s.userId);
    const userId = localUserId ?? session?.user?.id;
    const { fetchUserPersona } = useUserStore();
    const toast = useToast();
    const { t } = useTranslation();

    const [localFacts, setLocalFacts] = useState<Fact[]>([]);
    const [articleCountByTopic, setArticleCountByTopic] = useState<Map<string, number>>(new Map());
    const [countState, setCountState] = useState<ArticleCountState>('counting');
    const [expandedFactIds, setExpandedFactIds] = useState<Set<string>>(new Set());
    const [factToDelete, setFactToDelete] = useState<Fact | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const [addTopicFact, setAddTopicFact] = useState<Fact | null>(null);
    const [addTopicText, setAddTopicText] = useState('');
    const [isAddingTopic, setIsAddingTopic] = useState(false);
    const [generateMoreFact, setGenerateMoreFact] = useState<Fact | null>(null);
    const [generatingMoreFactIds, setGeneratingMoreFactIds] = useState<Set<string>>(new Set());

    const isChatExpanded = useFloatingChatIsExpanded();
    const isOnDeviceProcessing = useIsOnDeviceProcessing();
    const factMutationVersion = useFloatingChatFactMutationVersion();
    const knownFactIdsRef = useRef<Set<string>>(new Set());
    const isInitialLoadRef = useRef(true);
    const wasChatExpandedRef = useRef(false);
    const onFactsChangeRef = useRef(onFactsChange);
    onFactsChangeRef.current = onFactsChange;

    // Facts are live (observeFacts). Article counts are not (no observable
    // exists for them), so they are re-read: on mount, on focus (the Profile
    // tab stays mounted, so a mount-only read went stale for good), when a
    // feed-processing run finishes, on our own topic mutations, on
    // factMutationVersion and when the chat closes.
    //
    // Only rows that can actually APPEAR count (Q13): status complete and at
    // or above the render gate. The raw per-topic count included sub-gate and
    // unfinished rows, which is how a fact read "40 articles" while For You
    // had no section for it.
    const countsLoadedRef = useRef(false);
    const reloadArticleCounts = useCallback(async () => {
        try {
            const counts = await getRenderableArticleCountByTopicTexts();
            countsLoadedRef.current = true;
            setArticleCountByTopic(counts);
            setCountState('ready');
        } catch (error) {
            logger.warn('[FactsList] article counts unavailable', { error: String(error) });
            if (!countsLoadedRef.current) setCountState('unavailable');
        }
    }, []);

    useEffect(() => {
        const timer = setTimeout(() => {
            if (!countsLoadedRef.current) setCountState('unavailable');
        }, COUNTS_TIME_LIMIT_MS);
        return () => clearTimeout(timer);
    }, []);

    useFocusEffect(
        useCallback(() => {
            void reloadArticleCounts();
        }, [reloadArticleCounts]),
    );

    const lastRunFinishedAt = useForYouStore((s) => s.lastProcessingRunFinishedAt);
    useEffect(() => {
        if (lastRunFinishedAt) void reloadArticleCounts();
    }, [lastRunFinishedAt, reloadArticleCounts]);

    useEffect(() => {
        onFactsChangeRef.current?.(null);
        const sub = observeFacts().subscribe((facts) => {
            if (!isInitialLoadRef.current) {
                const newIds = facts
                    .filter(f => !knownFactIdsRef.current.has(f.id))
                    .map(f => f.id);
                if (newIds.length > 0) {
                    setExpandedFactIds(new Set([newIds[newIds.length - 1]]));
                }
            }
            isInitialLoadRef.current = false;
            knownFactIdsRef.current = new Set(facts.map(f => f.id));

            setLocalFacts(facts);
            onFactsChangeRef.current?.(facts);
        });
        void reloadArticleCounts();
        return () => sub.unsubscribe();
        // Mount-only subscription — matches the original FactsScreen behavior
        // where the facts fetch itself never depended on userId.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Real-time refresh when on-device LLM saves/deletes a fact or generates
    // topics. The facts array updates itself via observeFacts; this counter
    // still drives the two things it knows nothing about — the article-count
    // refetch and the persona/feed refresh.
    useEffect(() => {
        if (factMutationVersion > 0) {
            void reloadArticleCounts();
            if (userId) fetchUserPersona(userId, true);
            useForYouStore.getState().setFeedNeedsRefresh(true);
        }
    }, [factMutationVersion, reloadArticleCounts, fetchUserPersona, userId]);

    // When the floating chat popover collapses (true→false transition),
    // refresh counts + persona — the same refresh the old embedded chat's
    // closeChat did.
    useEffect(() => {
        if (wasChatExpandedRef.current && !isChatExpanded) {
            void reloadArticleCounts();
            if (userId) fetchUserPersona(userId, true);
        }
        wasChatExpandedRef.current = isChatExpanded;
    }, [isChatExpanded, reloadArticleCounts, fetchUserPersona, userId]);

    useImperativeHandle(ref, () => ({
        refresh: async () => {
            // Facts are already live; pull-to-refresh's remaining job is the
            // one thing that isn't — article counts.
            await reloadArticleCounts();
        },
    }), [reloadArticleCounts]);

    const toggleFact = useCallback((factId: string) => {
        setExpandedFactIds(prev => {
            if (prev.has(factId)) return new Set();
            return new Set([factId]);
        });
    }, []);

    const handleDeletePress = useCallback((fact: Fact) => {
        setFactToDelete(fact);
    }, []);

    const handleDeleteConfirm = useCallback(async () => {
        // Deleting a fact is a purely local write. It must not be gated on an
        // identity we may not have been able to confirm.
        if (!factToDelete) return;
        setIsDeleting(true);
        try {
            await deleteFact(factToDelete.id);

            setFactToDelete(null);
            void reloadArticleCounts();
            if (userId) fetchUserPersona(userId, true);
            useForYouStore.getState().setFeedNeedsRefresh(true);
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="success" variant="solid">
                        <ToastTitle>{t('configPanel.factDeletedTitle')}</ToastTitle>
                        <ToastDescription>{t('configPanel.factDeletedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } catch (error) {
            logger.error('[FactsList] deleteFact failed', error, {
                factId: factToDelete?.id,
            });
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('configPanel.deleteFailedTitle')}</ToastTitle>
                        <ToastDescription>{t('configPanel.deleteFailedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } finally {
            setIsDeleting(false);
        }
    }, [factToDelete, userId, reloadArticleCounts, fetchUserPersona, toast, t]);

    const handleDeleteCancel = useCallback(() => {
        setFactToDelete(null);
    }, []);

    const handleFactArticlesPress = useCallback((fact: Fact) => {
        const topicTexts = fact.metadata?.topics ?? [];
        if (topicTexts.length === 0) return;
        router.push({
            pathname: '/logged-in/persona-articles',
            params: { topicTexts: JSON.stringify(topicTexts), factStatement: fact.statement },
        });
    }, []);

    const handleTopicPress = useCallback((topicText: string) => {
        router.push({
            pathname: '/logged-in/persona-articles',
            params: { topicTexts: JSON.stringify([topicText]) },
        });
    }, []);

    const handleDeleteTopic = useCallback(async (fact: Fact, topicRow: { id: string; text: string }) => {
        // Routed through the same staged-delete-with-decline primitive the
        // chat chip uses (B3) — this is now a PERMANENT decline (the persona
        // agent will not re-propose this text), not a quiet local edit. The
        // row vanishes immediately from FactAccordion's own `observeByFact`
        // subscription; no reload here is needed for that. `fact.metadata.
        // topics` is pruned by `flushPendingDeletes` at commit, not here.
        try {
            await deleteTopicWithDecline(topicRow.id);
            if (userId) fetchUserPersona(userId, true);
            useForYouStore.getState().setFeedNeedsRefresh(true);
        } catch (error) {
            logger.error('[FactsList] deleteTopic failed', error, {
                factId: fact.id,
                topicId: topicRow.id,
            });
        }
    }, [fetchUserPersona, userId]);

    const handleAddTopicPress = useCallback((fact: Fact) => {
        setAddTopicFact(fact);
        setAddTopicText('');
    }, []);

    const handleAddTopicConfirm = useCallback(async () => {
        if (!addTopicFact || !addTopicText.trim()) return;
        setIsAddingTopic(true);
        try {
            const trimmed = addTopicText.trim();
            // createTopics resolves-or-creates against the fact's existing
            // rows (case-insensitive, normalized), so no manual duplicate
            // check is needed here — a re-add of an existing text is a no-op
            // that returns the existing row rather than erroring.
            // WEIGHT IS LOAD-BEARING: a topic at 0 is dropped by
            // buildRetrievalProfile and never queried, so a hand-added topic
            // used to render with its own row and fetch nothing, forever. Same
            // weight as a generated one, because a topic the user typed is at
            // least as strong a signal as one Mera inferred.
await createTopics([{ factId: addTopicFact.id, text: trimmed , weight: DEFAULT_HARNESS_CONFIG.topicGen.llmTopicWeight }]);
            setAddTopicFact(null);
            // metadata.topics is appended atomically inside createTopics
            // (v55 pairing) — this reload is only for the facts array/article
            // counts this screen still fetches one-shot (pending observeFacts).
            void reloadArticleCounts();
            if (userId) fetchUserPersona(userId, true);
            useForYouStore.getState().setFeedNeedsRefresh(true);
        } catch (error) {
            logger.error('[FactsList] addTopic failed', error, { factId: addTopicFact?.id });
        } finally {
            setIsAddingTopic(false);
        }
    }, [addTopicFact, addTopicText, reloadArticleCounts, fetchUserPersona, userId]);

    const handleAddTopicCancel = useCallback(() => {
        setAddTopicFact(null);
        setAddTopicText('');
    }, []);

    const handleGenerateMorePress = useCallback((fact: Fact) => {
        setGenerateMoreFact(fact);
    }, []);

    const handleGenerateMoreCancel = useCallback(() => {
        setGenerateMoreFact(null);
    }, []);

    const clearGeneratingMore = useCallback((factId: string) => {
        setGeneratingMoreFactIds(prev => {
            if (!prev.has(factId)) return prev;
            const next = new Set(prev);
            next.delete(factId);
            return next;
        });
    }, []);

    const showGenerateMoreFailedToast = useCallback(() => {
        toast.show({
            placement: 'top',
            render: () => (
                <Toast action="error" variant="solid">
                    <ToastTitle>{t('configPanel.generateMoreTopicsFailedTitle')}</ToastTitle>
                    <ToastDescription>{t('configPanel.generateMoreTopicsFailedDescription')}</ToastDescription>
                </Toast>
            ),
        });
    }, [toast, t]);

    const handleGenerateMoreConfirm = useCallback(async () => {
        const fact = generateMoreFact;
        // The lone survivor of the `!userId` guards above, deliberately: unlike
        // delete/add-topic this is not a pure local write — it enqueues an
        // inference job or calls the cloud, then refreshes the persona. With the
        // id read local-first it is unreachable in the offline / dead-session
        // cases anyway; it only stops a genuinely logged-out device spending an
        // LLM call.
        if (!fact || generatingMoreFactIds.has(fact.id) || !userId) return;
        setGenerateMoreFact(null);
        setGeneratingMoreFactIds(prev => new Set(prev).add(fact.id));
        const existingTopics = fact.metadata?.topics ?? [];
        try {
            if (isOnDeviceProcessing) {
                await enqueueJob('topic_gen', {
                    factId: fact.id,
                    factStatement: fact.statement,
                    useCloud: false,
                    mode: 'append',
                    totalCount: GENERATE_MORE_TOPIC_COUNT,
                    excludeTopics: existingTopics,
                });
                // Busy state clears when the queue drains (job done or failed);
                // the handler's notifyFactMutation() refreshes the fact list.
                inferenceQueue.onDrain(() => clearGeneratingMore(fact.id));
                inferenceQueue.notify();
                return;
            }
            const allFacts = await getFacts();
            const { userLocation, otherFacts } = buildTopicGenContext(allFacts, fact.id);
            const newTopics = await generateTopicsForFact({
                factStatement: fact.statement,
                userLocation,
                otherFacts,
                useCloud: true,
                totalCount: GENERATE_MORE_TOPIC_COUNT,
                excludeTopics: existingTopics,
            });
            if (newTopics.length === 0) {
                showGenerateMoreFailedToast();
            } else {
                // Converges with the on-device job handler
                // (lib/inference/handlers/topic-gen-handler.ts), which already
                // calls this — the cloud branch was the one path that used to
                // mint into metadata only and never reach the topics table.
                await syncLlmTopicsForFact(fact.id, newTopics);
                void reloadArticleCounts();
                fetchUserPersona(userId, true);
                useForYouStore.getState().setFeedNeedsRefresh(true);
            }
            clearGeneratingMore(fact.id);
        } catch (error) {
            logger.error('[FactsList] generateMoreTopics failed', error, { factId: fact.id });
            showGenerateMoreFailedToast();
            clearGeneratingMore(fact.id);
        }
    }, [generateMoreFact, generatingMoreFactIds, userId, isOnDeviceProcessing, clearGeneratingMore, showGenerateMoreFailedToast, reloadArticleCounts, fetchUserPersona]);

    return (
        <>
            {localFacts.map((fact) => (
                <FactAccordion
                    key={fact.id}
                    fact={fact}
                    isExpanded={expandedFactIds.has(fact.id)}
                    articleCountByTopic={articleCountByTopic}
                    countState={countState}
                    editing={editing}
                    isGeneratingMore={generatingMoreFactIds.has(fact.id)}
                    onToggle={toggleFact}
                    onDeletePress={handleDeletePress}
                    onFactArticles={handleFactArticlesPress}
                    onTopicPress={handleTopicPress}
                    onDeleteTopic={handleDeleteTopic}
                    onAddTopic={handleAddTopicPress}
                    onGenerateMore={handleGenerateMorePress}
                />
            ))}

            <AddTopicModal
                isOpen={addTopicFact !== null}
                value={addTopicText}
                isAdding={isAddingTopic}
                onChangeText={setAddTopicText}
                onConfirm={handleAddTopicConfirm}
                onCancel={handleAddTopicCancel}
            />

            <GenerateMoreModal
                isOpen={generateMoreFact !== null}
                onConfirm={handleGenerateMoreConfirm}
                onCancel={handleGenerateMoreCancel}
            />

            <DeleteFactModal
                fact={factToDelete}
                isDeleting={isDeleting}
                onConfirm={handleDeleteConfirm}
                onCancel={handleDeleteCancel}
            />
        </>
    );
});

FactsList.displayName = 'FactsList';

export default FactsList;
