import { StatusIndicator } from '@/components/custom/chat/StatusIndicator';
import { GlassPanel } from '@/components/custom/GlassSurface';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { retryTopicGeneration } from '@/lib/chat-tools/tool-handlers';
import { observeByFact } from '@/lib/database/services/topic-service';
import { nudgeFactWeight } from '@/lib/database/services/mutation-rails-service';
import { hapticLight } from '@/lib/haptics';
import logger from '@/lib/logger';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sentenceCase } from './sentence-case';

/** Per-tap influence nudge and the clamped UI range (a fact's weight dampens
 *  its topics — 100% default; this control never drives it to 0/negative). */
const INFLUENCE_STEP = 0.1;
const INFLUENCE_MIN = 0.1;
const INFLUENCE_MAX = 1.0;

/** Round to a single decimal so repeated ±0.1 taps don't accrue float drift. */
function round1(n: number): number {
    return Math.round(n * 10) / 10;
}

/** Accent for the row's actions. The facts list used an off-palette blue. */
const ACCENT = 'rgb(231, 138, 83)';

/**
 * Where the article counts are. `counting` until the first read lands,
 * `unavailable` once that read failed or ran past its time limit (FactsList
 * owns the limit), so a row never says "Counting" forever and never shows a
 * false 0.
 */
export type ArticleCountState = 'counting' | 'ready' | 'unavailable';

interface FactAccordionProps {
    readonly fact: Fact;
    readonly isExpanded: boolean;
    readonly articleCountByTopic: Map<string, number>;
    readonly countState?: ArticleCountState;
    /**
     * Edit mode (F46): the delete control shows only here, the row does not
     * expand, and the statement is the whole row. At rest there is no red
     * trash on every fact.
     */
    readonly editing?: boolean;
    readonly isGeneratingMore: boolean;
    readonly onToggle: (factId: string) => void;
    readonly onDeletePress: (fact: Fact) => void;
    readonly onFactArticles: (fact: Fact) => void;
    readonly onTopicPress: (topicText: string) => void;
    readonly onDeleteTopic: (fact: Fact, topicRow: { id: string; text: string }) => void;
    readonly onAddTopic: (fact: Fact) => void;
    readonly onGenerateMore: (fact: Fact) => void;
}

/**
 * A single fact accordion — header (delete, statement, article-count pill,
 * expand chevron) plus an expandable body listing the fact's topics with their
 * article counts, per-topic delete, add-topic, and generate-more affordances.
 *
 * Extracted verbatim (Wave 12) from PersonaL1MeraProtocol's inline fact map;
 * behavior, routes, and services are unchanged — the parent FactsScreen owns
 * all state and handlers.
 */
const FactAccordion: React.FC<FactAccordionProps> = ({
    fact,
    isExpanded: isExpandedProp,
    articleCountByTopic,
    countState = 'ready',
    editing = false,
    isGeneratingMore,
    onToggle,
    onDeletePress,
    onFactArticles,
    onTopicPress,
    onDeleteTopic,
    onAddTopic,
    onGenerateMore,
}) => {
    const { t } = useTranslation();
    const isExpanded = isExpandedProp && !editing;
    const displayStatement = sentenceCase(fact.statement);

    // Optimistic mirror of the fact's influence weight (null ⇒ 1.0 baseline).
    // nudgeFactWeight reads the stored value fresh each call, so the UI value
    // and the DB value move by the same delta and stay in sync.
    const [influence, setInfluence] = useState<number>(round1(fact.weight ?? 1));
    useEffect(() => {
        setInfluence(round1(fact.weight ?? 1));
    }, [fact.id, fact.weight]);

    const influenceMinReached = influence <= INFLUENCE_MIN + 1e-6;
    const influenceMaxReached = influence >= INFLUENCE_MAX - 1e-6;

    const handleInfluence = useCallback(
        async (direction: 1 | -1) => {
            const delta = INFLUENCE_STEP * direction;
            const next = round1(Math.max(INFLUENCE_MIN, Math.min(INFLUENCE_MAX, influence + delta)));
            if (next === influence) return; // at a bound — nothing to do
            const prev = influence;
            setInfluence(next);
            void hapticLight();
            try {
                await nudgeFactWeight(fact.id, delta, 'user');
                useForYouStore.getState().setFeedNeedsRefresh(true);
            } catch (err) {
                setInfluence(prev); // revert optimistic update on failure
                logger.warn('[fact-accordion] influence nudge failed', {
                    factId: fact.id,
                    error: String(err),
                });
            }
        },
        [influence, fact.id],
    );

    // B3 — the topic LIST renders from the `topics` table, the same source
    // `TopicPlanCard` (chat) reads via `observeByFact`, not from
    // `fact.metadata.topics`. Before this, a topic deleted in chat stayed on
    // this screen forever: two readers, two lists, no way for either delete
    // path to reach the other's. `fact.metadata.topics` is still read below,
    // ONLY for the interim status heuristic (pending P3's DTO field) — never
    // for what's rendered.
    const [activeTopics, setActiveTopics] = useState<{ id: string; text: string }[]>([]);
    useEffect(() => {
        const sub = observeByFact(fact.id).subscribe((rows) => {
            // No undo-chip UI exists on this screen (unlike the chat chip), so
            // 'retired' rows — a permanent status from persona-change-log
            // reverts / article feedback, NOT the same thing as a staged
            // pending_delete_at row — are not shown; there is nothing here for
            // the user to undo them from. A staged row is already excluded by
            // `observeByFact` itself.
            setActiveTopics(
                rows
                    .filter((r) => r.status === 'active')
                    .map((r) => ({ id: r.id, text: r.text })),
            );
        });
        return () => sub.unsubscribe();
    }, [fact.id]);

    const totalCount = activeTopics.reduce(
        (sum, topic) => sum + (articleCountByTopic.get(topic.text) ?? 0),
        0,
    );

    // P3's DTO commit landed: NULL means "generation never asked for" and
    // renders exactly like done, never as a spinner — never branch on null.
    // This is independent of `activeTopics` above: topics_status drives only
    // the progress affordance, the topic list always renders from the table
    // regardless of status, so drift between them costs a stale spinner, not
    // a hidden interest (P3's plan, §4.1).
    const status: 'pending' | 'done' | 'error' = fact.topicsStatus ?? 'done';

    // Busy state follows `status` leaving 'error', not the settled promise —
    // retryTopicGeneration is an enqueue, not a completion (its on-device path
    // resolves once the job is queued, before it runs), so a `finally` clear
    // would race ahead of the actual outcome. See mera-app-persona's P4 plan.
    const [isRetrying, setIsRetrying] = useState(false);
    useEffect(() => {
        if (status !== 'error') setIsRetrying(false);
    }, [status]);

    const handleRetry = useCallback(() => {
        if (isRetrying) return;
        setIsRetrying(true);
        // Never rejects (see its own doc comment) — no catch/toast needed.
        void retryTopicGeneration(fact.id, fact.statement);
    }, [isRetrying, fact.id, fact.statement]);

    return (
        <GlassPanel className="mx-4 mb-3" fallbackClassName="bg-transparent">
            {/* Accordion header */}
            <HStack className="px-4 py-3 items-center">
                {editing && (
                    <Pressable
                        testID={`fact-delete-${fact.id}`}
                        onPress={() => onDeletePress(fact)}
                        accessibilityRole="button"
                        accessibilityLabel={t('facts.deleteFactA11y', { fact: displayStatement })}
                        className="w-11 h-11 -ml-2 mr-1 items-center justify-center"
                    >
                        <MaterialIcons name="remove-circle" size={22} color="#ef4444" />
                    </Pressable>
                )}
                <Pressable
                    onPress={editing ? undefined : () => onToggle(fact.id)}
                    className="flex-1 mr-2"
                    accessibilityRole={editing ? undefined : 'button'}
                    accessibilityState={editing ? undefined : { expanded: isExpanded }}
                    // Delete is reachable from VoiceOver's actions rotor on
                    // every row, not only in edit mode.
                    accessibilityActions={[{ name: 'delete', label: t('common.delete') }]}
                    onAccessibilityAction={(e) => {
                        if (e.nativeEvent.actionName === 'delete') onDeletePress(fact);
                    }}
                >
                    {/* The statement ALWAYS renders, in full: pending/error
                        only add a line beneath it, and it is never clamped,
                        because a person has to be able to read their own
                        fact. */}
                    <TranslatableDynamic
                        text={displayStatement}
                        size="md"
                        className="text-white"
                    />
                    {status === 'pending' && (
                        <Text size="xs" className="text-typography-400 mt-0.5">
                            {t('configPanel.generatingTopics')}
                        </Text>
                    )}
                    {status === 'error' && (
                        <Text size="xs" className="text-gray-500 mt-0.5">
                            {t('configPanel.topicGenFailedGeneric')}
                        </Text>
                    )}
                </Pressable>
                <HStack space="xs" className="items-center">
                    {status === 'pending' && (
                        <StatusIndicator status="pending" testID={`fact-topics-pending-${fact.id}`} />
                    )}
                    {status === 'error' && !editing && (
                        <Pressable
                            onPress={handleRetry}
                            disabled={isRetrying}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={t('configPanel.retryTopicGeneration')}
                            accessibilityState={{ disabled: isRetrying }}
                            testID={`fact-topics-retry-${fact.id}`}
                        >
                            <StatusIndicator
                                status="error"
                                label={t('configPanel.retryTopicGeneration')}
                            />
                        </Pressable>
                    )}
                    {status === 'done' && countState === 'counting' && (
                        <Text size="xs" className="text-gray-500" testID={`fact-count-pending-${fact.id}`}>
                            {t('configPanel.articleCountPending')}
                        </Text>
                    )}
                    {status === 'done' && countState === 'ready' && totalCount > 0 && (
                        <Button
                            variant="outline"
                            size="xs"
                            onPress={() => onFactArticles(fact)}
                            className="rounded-full"
                            isDisabled={editing}
                        >
                            <ButtonText>{t('configPanel.articleCount', { count: totalCount })}</ButtonText>
                        </Button>
                    )}
                    {/* M24: a finished fact with nothing that can appear says
                        so, instead of showing no pill at all. */}
                    {status === 'done' && countState === 'ready' && totalCount === 0 && (
                        <Text size="xs" className="text-gray-500" testID={`fact-count-none-${fact.id}`}>
                            {t('configPanel.articleCountNone')}
                        </Text>
                    )}
                    {!editing && (
                        <Pressable
                            onPress={() => onToggle(fact.id)}
                            hitSlop={8}
                            accessibilityElementsHidden
                            importantForAccessibility="no"
                        >
                            <MaterialIcons
                                name={isExpanded ? 'expand-less' : 'expand-more'}
                                size={20}
                                color="#9ca3af"
                            />
                        </Pressable>
                    )}
                </HStack>
            </HStack>

            {/* Accordion body */}
            {isExpanded && (
                <Box className="px-4 py-3">
                    {/* Influence — how strongly this fact dampens its topics */}
                    <HStack className="items-center justify-between pb-3 mb-3">
                        <Text size="sm" className="text-gray-400 font-medium">
                            {t('facts.influence', { defaultValue: 'Influence' })}
                        </Text>
                        <HStack space="md" className="items-center">
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('facts.lessInfluence', { defaultValue: 'Less influence' })}
                                disabled={influenceMinReached}
                                onPress={() => handleInfluence(-1)}
                                hitSlop={8}
                            >
                                <MaterialIcons
                                    name="remove-circle-outline"
                                    size={22}
                                    color={influenceMinReached ? '#374151' : ACCENT}
                                />
                            </Pressable>
                            <Text size="sm" className="text-gray-200" style={{ minWidth: 44, textAlign: 'center' }}>
                                {Math.round(influence * 100)}%
                            </Text>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('facts.moreInfluence', { defaultValue: 'More influence' })}
                                disabled={influenceMaxReached}
                                onPress={() => handleInfluence(1)}
                                hitSlop={8}
                            >
                                <MaterialIcons
                                    name="add-circle-outline"
                                    size={22}
                                    color={influenceMaxReached ? '#374151' : ACCENT}
                                />
                            </Pressable>
                        </HStack>
                    </HStack>
                    {status === 'error' ? (
                        // The consequence text now lives under the statement
                        // in the header, always visible — not duplicated
                        // here. This is just the larger, expanded-only retry
                        // tap target.
                        <Pressable
                            onPress={handleRetry}
                            disabled={isRetrying}
                            accessibilityRole="button"
                            accessibilityLabel={t('configPanel.retryTopicGeneration')}
                            accessibilityState={{ disabled: isRetrying }}
                            testID={`fact-topics-retry-body-button-${fact.id}`}
                        >
                            <Text size="sm" className="text-primary-400">
                                {t('configPanel.retryTopicGeneration')}
                            </Text>
                        </Pressable>
                    ) : status === 'pending' ? (
                        // Nothing here either — the "Generating topics…" line
                        // is under the statement in the header, expanded or
                        // not, so there is nothing left to say twice.
                        null
                    ) : (
                        <VStack space="sm">
                            {activeTopics.map(topicRow => {
                                const count = articleCountByTopic.get(topicRow.text) ?? 0;
                                return (
                                    <HStack key={topicRow.id} className="items-center">
                                        <Pressable className="flex-1" onPress={() => onTopicPress(topicRow.text)}>
                                            <HStack className="items-center justify-between flex-1 mr-3">
                                                <TranslatableDynamic
                                                    text={sentenceCase(topicRow.text)}
                                                    size="sm"
                                                    className="text-gray-200 flex-1 mr-2"
                                                    numberOfLines={2}
                                                />
                                                {countState === 'ready' && (
                                                    <Text size="xs" className="text-gray-500">
                                                        {t('configPanel.articleCount', { count })}
                                                    </Text>
                                                )}
                                            </HStack>
                                        </Pressable>
                                        <Pressable
                                            onPress={() => onDeleteTopic(fact, topicRow)}
                                            hitSlop={8}
                                            className="ml-1"
                                            testID={`topic-delete-${topicRow.id}`}
                                        >
                                            <MaterialIcons name="delete-outline" size={16} color="#6b7280" />
                                        </Pressable>
                                    </HStack>
                                );
                            })}
                            {activeTopics.length > 0 && (
                                // Round-2 review item (10): a delete here now
                                // records a PERMANENT decline (B3 routes it
                                // through the same primitive as the chat
                                // chip's staged delete), not a quiet local
                                // edit — name the consequence and where the
                                // way back is, once per fact rather than once
                                // per row.
                                <Text size="xs" className="text-gray-500">
                                    {t('facts.topicRemovalConsequence')}
                                </Text>
                            )}
                            <Pressable onPress={() => onAddTopic(fact)} className="mt-1">
                                <HStack className="items-center" space="xs">
                                    <MaterialIcons name="add" size={16} color={ACCENT} />
                                    <Text size="sm" className="text-primary-400">{t('configPanel.addTopic')}</Text>
                                </HStack>
                            </Pressable>
                            {isGeneratingMore ? (
                                <HStack className="items-center mt-1" space="xs">
                                    <Spinner size="small" />
                                    <Text size="sm" className="text-typography-400">{t('configPanel.generatingMoreTopics')}</Text>
                                </HStack>
                            ) : (
                                <Pressable onPress={() => onGenerateMore(fact)} className="mt-1">
                                    <HStack className="items-center" space="xs">
                                        <MaterialIcons name="auto-awesome" size={16} color={ACCENT} />
                                        <Text size="sm" className="text-primary-400">{t('configPanel.generateMoreTopics')}</Text>
                                    </HStack>
                                </Pressable>
                            )}
                        </VStack>
                    )}
                </Box>
            )}
        </GlassPanel>
    );
};

export default FactAccordion;
