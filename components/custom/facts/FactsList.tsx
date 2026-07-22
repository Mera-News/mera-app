import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { authClient } from '@/lib/auth-client';
import { getArticleCountByTopicTexts } from '@/lib/database/services/article-suggestion-service';
import { deleteFact, getFacts, updateFact } from '@/lib/database/services/fact-service';
import { enqueueJob } from '@/lib/database/services/inference-job-service';
import { buildTopicGenContext } from '@/lib/inference/handlers/topic-gen-handler';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import logger from '@/lib/logger';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { generateTopicsForFact, mergeTopicsAppend } from '@/lib/mera-protocol/topic-generation-service';
import { useFloatingChatFactMutationVersion, useFloatingChatIsExpanded } from '@/lib/stores/floating-chat-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useIsOnDeviceProcessing } from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
import { router } from 'expo-router';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AddTopicModal from './AddTopicModal';
import DeleteFactModal from './DeleteFactModal';
import FactAccordion from './FactAccordion';
import GenerateMoreModal from './GenerateMoreModal';

const GENERATE_MORE_TOPIC_COUNT = 10;

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
const FactsList = forwardRef<FactsListHandle, FactsListProps>(({ onFactsChange }, ref) => {
    const { data: session } = authClient.useSession();
    const userId = session?.user?.id;
    const { fetchUserPersona } = useUserStore();
    const toast = useToast();
    const { t } = useTranslation();

    const [localFacts, setLocalFacts] = useState<Fact[]>([]);
    const [articleCountByTopic, setArticleCountByTopic] = useState<Map<string, number>>(new Map());
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

    const loadLocalFacts = useCallback(async () => {
        const [facts, counts] = await Promise.all([
            getFacts(),
            getArticleCountByTopicTexts(),
        ]);

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
        setArticleCountByTopic(counts);
        onFactsChangeRef.current?.(facts);
        return facts;
    }, []);

    useEffect(() => {
        onFactsChangeRef.current?.(null);
        loadLocalFacts();
        // Mount-only initial load — matches the original FactsScreen behavior
        // where the facts fetch itself never depended on userId.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Real-time refresh when on-device LLM saves/deletes a fact or generates topics
    useEffect(() => {
        if (factMutationVersion > 0 && userId) {
            loadLocalFacts();
            fetchUserPersona(userId, true);
            useForYouStore.getState().setFeedNeedsRefresh(true);
        }
    }, [factMutationVersion, loadLocalFacts, fetchUserPersona, userId]);

    // When the floating chat popover collapses (true→false transition), reload
    // facts + persona — the same refresh the old embedded chat's closeChat did.
    useEffect(() => {
        if (wasChatExpandedRef.current && !isChatExpanded && userId) {
            loadLocalFacts();
            fetchUserPersona(userId, true);
        }
        wasChatExpandedRef.current = isChatExpanded;
    }, [isChatExpanded, loadLocalFacts, fetchUserPersona, userId]);

    useImperativeHandle(ref, () => ({
        refresh: async () => {
            await loadLocalFacts();
        },
    }), [loadLocalFacts]);

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
        if (!factToDelete || !userId) return;
        setIsDeleting(true);
        try {
            await deleteFact(factToDelete.id);

            setFactToDelete(null);
            loadLocalFacts();
            fetchUserPersona(userId, true);
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
    }, [factToDelete, userId, loadLocalFacts, fetchUserPersona, toast, t]);

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

    const handleDeleteTopic = useCallback(async (fact: Fact, topicText: string) => {
        if (!userId) return;
        const currentTopics = fact.metadata?.topics ?? [];
        const updatedTopics = currentTopics.filter(topic => topic !== topicText);
        try {
            await updateFact(fact.id, {
                metadata: { ...(fact.metadata ?? {}), topics: updatedTopics },
            });
            loadLocalFacts();
            fetchUserPersona(userId, true);
            useForYouStore.getState().setFeedNeedsRefresh(true);
        } catch (error) {
            logger.error('[FactsList] deleteTopic failed', error, { factId: fact.id, topicText });
        }
    }, [loadLocalFacts, fetchUserPersona, userId]);

    const handleAddTopicPress = useCallback((fact: Fact) => {
        setAddTopicFact(fact);
        setAddTopicText('');
    }, []);

    const handleAddTopicConfirm = useCallback(async () => {
        if (!addTopicFact || !addTopicText.trim() || !userId) return;
        setIsAddingTopic(true);
        try {
            const currentTopics = addTopicFact.metadata?.topics ?? [];
            const trimmed = addTopicText.trim();
            if (currentTopics.includes(trimmed)) {
                setAddTopicFact(null);
                return;
            }
            await updateFact(addTopicFact.id, {
                metadata: { ...(addTopicFact.metadata ?? {}), topics: [...currentTopics, trimmed] },
            });
            setAddTopicFact(null);
            loadLocalFacts();
            fetchUserPersona(userId, true);
            useForYouStore.getState().setFeedNeedsRefresh(true);
        } catch (error) {
            logger.error('[FactsList] addTopic failed', error, { factId: addTopicFact?.id });
        } finally {
            setIsAddingTopic(false);
        }
    }, [addTopicFact, addTopicText, loadLocalFacts, fetchUserPersona, userId]);

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
                await updateFact(fact.id, {
                    metadata: { ...(fact.metadata ?? {}), topics: mergeTopicsAppend(existingTopics, newTopics) },
                });
                loadLocalFacts();
                fetchUserPersona(userId, true);
                useForYouStore.getState().setFeedNeedsRefresh(true);
            }
            clearGeneratingMore(fact.id);
        } catch (error) {
            logger.error('[FactsList] generateMoreTopics failed', error, { factId: fact.id });
            showGenerateMoreFailedToast();
            clearGeneratingMore(fact.id);
        }
    }, [generateMoreFact, generatingMoreFactIds, userId, isOnDeviceProcessing, clearGeneratingMore, showGenerateMoreFailedToast, loadLocalFacts, fetchUserPersona]);

    return (
        <>
            {localFacts.map((fact) => (
                <FactAccordion
                    key={fact.id}
                    fact={fact}
                    isExpanded={expandedFactIds.has(fact.id)}
                    articleCountByTopic={articleCountByTopic}
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
