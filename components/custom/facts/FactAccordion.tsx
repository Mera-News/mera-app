import { GlassPanel } from '@/components/custom/GlassSurface';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { nudgeFactWeight } from '@/lib/database/services/mutation-rails-service';
import { hapticLight } from '@/lib/haptics';
import logger from '@/lib/logger';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Per-tap influence nudge and the clamped UI range (a fact's weight dampens
 *  its topics — 100% default; this control never drives it to 0/negative). */
const INFLUENCE_STEP = 0.1;
const INFLUENCE_MIN = 0.1;
const INFLUENCE_MAX = 1.0;

/** Round to a single decimal so repeated ±0.1 taps don't accrue float drift. */
function round1(n: number): number {
    return Math.round(n * 10) / 10;
}

/** Matches `topic-service.normalizeTopicText`, reimplemented rather than
 *  imported: this is a render-layer comparison and pulling `lib/database` into
 *  a presentational component would widen its import graph for nothing. */
function normalizeTopic(s: string): string {
    return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

interface FactAccordionProps {
    readonly fact: Fact;
    readonly isExpanded: boolean;
    readonly articleCountByTopic: Map<string, number>;
    readonly isGeneratingMore: boolean;
    /** Free-tier read-only flag, threaded from FactsList. Disables every
     *  mutating control on this row (delete fact/topic, add topic, generate
     *  more, influence nudge) while leaving expand/navigate untouched — the
     *  influence nudge in particular has no parent handler to gate, since
     *  `handleInfluence` below calls `nudgeFactWeight` directly. */
    readonly readOnly: boolean;
    /** Mera News Free is applying the two-oldest-facts cap. */
    readonly capped: boolean;
    /** This fact is one of the two that stay live. Meaningless unless `capped`. */
    readonly unlocked: boolean;
    /** Normalized topic texts already rendered under an unlocked fact above.
     *  A paused fact does not repeat them: the same text under both a live and
     *  a paused fact is real (createTopics keys on `(normalized_text, fact_id)`)
     *  and showing it twice, once as working and once as paused, is
     *  incomprehensible. Retrieval is untouched, so the text is still fetched. */
    readonly hiddenTopics: ReadonlySet<string>;
    /** Opens the explainer sheet. */
    readonly onExplain: () => void;
    readonly onToggle: (factId: string) => void;
    readonly onDeletePress: (fact: Fact) => void;
    readonly onFactArticles: (fact: Fact) => void;
    readonly onTopicPress: (topicText: string) => void;
    readonly onDeleteTopic: (fact: Fact, topicText: string) => void;
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
    isExpanded,
    articleCountByTopic,
    isGeneratingMore,
    readOnly,
    capped,
    unlocked,
    hiddenTopics,
    onExplain,
    onToggle,
    onDeletePress,
    onFactArticles,
    onTopicPress,
    onDeleteTopic,
    onAddTopic,
    onGenerateMore,
}) => {
    const { t } = useTranslation();

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

    const paused = capped && !unlocked;
    const allFactTopics = fact.metadata?.topics ?? [];
    // See `hiddenTopics`. Only a paused fact hides anything.
    const factTopics = paused
        ? allFactTopics.filter((t) => !hiddenTopics.has(normalizeTopic(t)))
        : allFactTopics;
    const expectedTopicCount = allFactTopics.length;
    const topicGenError = fact.metadata?.topicGenError?.[0];
    const topicsSettled = !!topicGenError || expectedTopicCount > 0;
    const totalCount = factTopics.reduce(
        (sum, topic) => sum + (articleCountByTopic.get(topic) ?? 0),
        0,
    );

    return (
        <GlassPanel className="mx-4 mb-3" fallbackClassName="bg-transparent">
            {/* Accordion header */}
            <HStack className="px-4 py-3 items-center">
                {/* Hidden, not disabled, while capped. `disabled` left it at full
                    #ef4444, so it read as a live destructive control that
                    silently did nothing on every press. */}
                {!capped && (
                    <Pressable onPress={() => onDeletePress(fact)} disabled={readOnly} hitSlop={8} className="mr-3">
                        <MaterialIcons name="delete-outline" size={20} color="#ef4444" />
                    </Pressable>
                )}
                <Pressable onPress={() => onToggle(fact.id)} className="flex-1 mr-2">
                    <TranslatableDynamic
                        text={fact.statement}
                        size="md"
                        className="text-white capitalize"
                        numberOfLines={2}
                    />
                </Pressable>
                <HStack space="xs" className="items-center">
                    {paused && (
                        <Box
                            testID={`fact-paused-badge-${fact.id}`}
                            className="rounded-full border border-white/20 px-2.5 py-1"
                        >
                            <Text size="xs" className="text-gray-400">
                                {t('freeTier.pausedBadge')}
                            </Text>
                        </Box>
                    )}
                    {!paused && !topicsSettled && <Spinner size="small" />}
                    {/* No article count on a paused fact: nothing is fetched for
                        it, so the number would be a frozen leftover. */}
                    {!paused && topicsSettled && totalCount > 0 && (
                        <Button
                            variant="outline"
                            size="xs"
                            onPress={() => onFactArticles(fact)}
                            className="rounded-full"
                        >
                            <ButtonText>{t('configPanel.articleCount', { count: totalCount })}</ButtonText>
                        </Button>
                    )}
                    <Pressable onPress={() => onToggle(fact.id)} hitSlop={8}>
                        <MaterialIcons
                            name={isExpanded ? 'expand-less' : 'expand-more'}
                            size={20}
                            color="#9ca3af"
                        />
                    </Pressable>
                </HStack>
            </HStack>

            {/* Accordion body */}
            {isExpanded && (
                <Box className="px-4 py-3">
                    {/* Influence, in three states.
                        - Paused: hidden entirely. A percentage control reporting
                          100% on a fact contributing nothing is worse than
                          absent, especially sitting above the upgrade line.
                        - Capped but live: the value without the steppers. It
                          still means something; it just is not adjustable.
                        - Entitled: unchanged. */}
                    {paused ? null : capped ? (
                        <HStack className="items-center justify-between pb-3 mb-3">
                            <Text size="sm" className="text-gray-400 font-medium">
                                {t('facts.influence', { defaultValue: 'Influence' })}
                            </Text>
                            <Text size="sm" className="text-gray-200">
                                {Math.round(influence * 100)}%
                            </Text>
                        </HStack>
                    ) : (
                    <HStack className="items-center justify-between pb-3 mb-3">
                        <Text size="sm" className="text-gray-400 font-medium">
                            {t('facts.influence', { defaultValue: 'Influence' })}
                        </Text>
                        <HStack space="md" className="items-center">
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('facts.lessInfluence', { defaultValue: 'Less influence' })}
                                disabled={influenceMinReached || readOnly}
                                onPress={() => handleInfluence(-1)}
                                hitSlop={8}
                            >
                                <MaterialIcons
                                    name="remove-circle-outline"
                                    size={22}
                                    color={influenceMinReached || readOnly ? '#374151' : '#60a5fa'}
                                />
                            </Pressable>
                            <Text size="sm" className="text-gray-200" style={{ minWidth: 44, textAlign: 'center' }}>
                                {Math.round(influence * 100)}%
                            </Text>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('facts.moreInfluence', { defaultValue: 'More influence' })}
                                disabled={influenceMaxReached || readOnly}
                                onPress={() => handleInfluence(1)}
                                hitSlop={8}
                            >
                                <MaterialIcons
                                    name="add-circle-outline"
                                    size={22}
                                    color={influenceMaxReached || readOnly ? '#374151' : '#60a5fa'}
                                />
                            </Pressable>
                        </HStack>
                    </HStack>
                    )}
                    {/* The one affordance a paused fact has: say why, in one tap. */}
                    {paused && (
                        <Pressable
                            testID={`fact-paused-hint-${fact.id}`}
                            onPress={onExplain}
                            className="pb-3 mb-3"
                        >
                            <Text size="sm" className="text-primary-400">
                                {t('freeTier.pausedRowHint')}
                            </Text>
                        </Pressable>
                    )}
                    {topicGenError ? (
                        <Text className="text-red-400 text-sm">
                            {t('configPanel.topicGenFailed', { error: topicGenError })}
                        </Text>
                    ) : !topicsSettled ? (
                        <Text className="text-typography-400 text-sm">
                            {t('configPanel.generatingTopics')}
                        </Text>
                    ) : (
                        <VStack space="sm">
                            {factTopics.map(topicText => {
                                const count = articleCountByTopic.get(topicText) ?? 0;
                                return (
                                    <HStack key={topicText} className="items-center">
                                        <Pressable className="flex-1" onPress={() => onTopicPress(topicText)}>
                                            <HStack className="items-center justify-between flex-1 mr-3">
                                                <TranslatableDynamic
                                                    text={topicText}
                                                    size="sm"
                                                    className="text-gray-200 flex-1 mr-2 capitalize"
                                                    numberOfLines={2}
                                                />
                                                {!paused && (
                                                    <Text size="xs" className="text-gray-500">
                                                        {t('configPanel.articleCount', { count })}
                                                    </Text>
                                                )}
                                            </HStack>
                                        </Pressable>
                                        {/* Same defect as the fact-level control:
                                            disabled but full-strength, so it read
                                            live and did nothing. Hidden while
                                            capped. */}
                                        {!capped && (
                                            <Pressable
                                                onPress={() => onDeleteTopic(fact, topicText)}
                                                disabled={readOnly}
                                                hitSlop={8}
                                                className="ml-1"
                                            >
                                                <MaterialIcons name="delete-outline" size={16} color="#6b7280" />
                                            </Pressable>
                                        )}
                                    </HStack>
                                );
                            })}
                            {/* No topic creation on Mera News Free. Adding is
                                refused in the chat tool too (D17), and
                                "Generate more" is an LLM call, which is paid
                                (D24): a user who cannot add one topic by hand
                                but can have a model mint ten would be
                                incoherent. Removed rather than disabled so the
                                next reader does not read them as reachable. */}
                            {!capped && (
                                <>
                                    <Pressable onPress={() => onAddTopic(fact)} disabled={readOnly} className="mt-1">
                                        <HStack className="items-center" space="xs">
                                            <MaterialIcons name="add" size={16} color={readOnly ? '#374151' : '#60a5fa'} />
                                            <Text size="sm" className={readOnly ? 'text-gray-600' : 'text-blue-400'}>{t('configPanel.addTopic')}</Text>
                                        </HStack>
                                    </Pressable>
                                    {isGeneratingMore ? (
                                        <HStack className="items-center mt-1" space="xs">
                                            <Spinner size="small" />
                                            <Text size="sm" className="text-typography-400">{t('configPanel.generatingMoreTopics')}</Text>
                                        </HStack>
                                    ) : (
                                        <Pressable onPress={() => onGenerateMore(fact)} disabled={readOnly} className="mt-1">
                                            <HStack className="items-center" space="xs">
                                                <MaterialIcons name="auto-awesome" size={16} color={readOnly ? '#374151' : '#60a5fa'} />
                                                <Text size="sm" className={readOnly ? 'text-gray-600' : 'text-blue-400'}>{t('configPanel.generateMoreTopics')}</Text>
                                            </HStack>
                                        </Pressable>
                                    )}
                                </>
                            )}
                        </VStack>
                    )}
                </Box>
            )}
        </GlassPanel>
    );
};

export default FactAccordion;
