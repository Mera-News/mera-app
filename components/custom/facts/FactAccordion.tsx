import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface FactAccordionProps {
    readonly fact: Fact;
    readonly isExpanded: boolean;
    readonly articleCountByTopic: Map<string, number>;
    readonly isGeneratingMore: boolean;
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
    onToggle,
    onDeletePress,
    onFactArticles,
    onTopicPress,
    onDeleteTopic,
    onAddTopic,
    onGenerateMore,
}) => {
    const { t } = useTranslation();

    const factTopics = fact.metadata?.topics ?? [];
    const expectedTopicCount = factTopics.length;
    const topicGenError = fact.metadata?.topicGenError?.[0];
    const topicsSettled = !!topicGenError || expectedTopicCount > 0;
    const totalCount = factTopics.reduce(
        (sum, topic) => sum + (articleCountByTopic.get(topic) ?? 0),
        0,
    );

    return (
        <Box className="mx-4 mb-3 border border-gray-700 rounded-lg overflow-hidden">
            {/* Accordion header */}
            <HStack className="px-4 py-3 items-center">
                <Pressable onPress={() => onDeletePress(fact)} hitSlop={8} className="mr-3">
                    <MaterialIcons name="delete-outline" size={20} color="#ef4444" />
                </Pressable>
                <Pressable onPress={() => onToggle(fact.id)} className="flex-1 mr-2">
                    <TranslatableDynamic
                        text={fact.statement}
                        size="md"
                        className="text-white capitalize"
                        numberOfLines={2}
                    />
                </Pressable>
                <HStack space="xs" className="items-center">
                    {!topicsSettled && <Spinner size="small" />}
                    {topicsSettled && totalCount > 0 && (
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
                <Box className="border-t border-gray-700 px-4 py-3">
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
                                                <Text size="xs" className="text-gray-500">
                                                    {t('configPanel.articleCount', { count })}
                                                </Text>
                                            </HStack>
                                        </Pressable>
                                        <Pressable
                                            onPress={() => onDeleteTopic(fact, topicText)}
                                            hitSlop={8}
                                            className="ml-1"
                                        >
                                            <MaterialIcons name="delete-outline" size={16} color="#6b7280" />
                                        </Pressable>
                                    </HStack>
                                );
                            })}
                            <Pressable onPress={() => onAddTopic(fact)} className="mt-1">
                                <HStack className="items-center" space="xs">
                                    <MaterialIcons name="add" size={16} color="#60a5fa" />
                                    <Text size="sm" className="text-blue-400">{t('configPanel.addTopic')}</Text>
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
                                        <MaterialIcons name="auto-awesome" size={16} color="#60a5fa" />
                                        <Text size="sm" className="text-blue-400">{t('configPanel.generateMoreTopics')}</Text>
                                    </HStack>
                                </Pressable>
                            )}
                        </VStack>
                    )}
                </Box>
            )}
        </Box>
    );
};

export default FactAccordion;
