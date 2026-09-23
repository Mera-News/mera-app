import { GlassPanel } from '@/components/custom/GlassSurface';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { sentenceCase } from './sentence-case';

/**
 * One row of `lib/database/services/topic-decline-service.ts`'s
 * `listDeclinedTopics()` — kept as a small local shape rather than importing
 * that module's `DeclinedTopic` type, because this component is presentational
 * only and is being built ahead of that service landing (P4, gated on P3).
 * The real row also carries `normalizedText` and `createdAt`; neither is ever
 * rendered here, and `sourceFactId` is read only by the host that decides
 * whether "Allow this again" also re-mints the topic (see `FactsScreen.tsx`,
 * not this file) — this component just reports which item was pressed.
 */
export interface DeclinedTopicItem {
    readonly id: string;
    readonly text: string;
    readonly sourceFactId: string | null;
}

interface DeclinedTopicsSectionProps {
    readonly items: readonly DeclinedTopicItem[];
    readonly onAllowAgain: (item: DeclinedTopicItem) => void;
}

/**
 * "Topics you removed" — the visible, reversible side of a topic decline.
 * `deleteTopicWithDecline` (the chat chip, and the facts screen's own topic
 * delete once it moves onto the same primitive) records a decline that
 * suppresses future re-proposal of that topic; without a place to see and
 * un-suppress it, that delete is a one-way door with no visible way back.
 *
 * Renders NOTHING — not even the section header — when there is nothing
 * declined. A permanent empty-state row is clutter for the common case (a new
 * account, or a user who has never declined anything), and every other empty
 * state on this screen (add-topic, generate-more) is likewise silent until
 * there's something to show.
 *
 * "Allow this again" copy is deliberate, not a stand-in for "Restore":
 * `removeDecline(id)` only forgets the decline — the underlying topic row was
 * already destroyed when the delete committed, so there is nothing to bring
 * back by forgetting alone. Whether the host additionally re-mints the topic
 * via `createTopics` when `sourceFactId` is present is a decision made by
 * whatever wires this component to real data, not by this component.
 */
const DeclinedTopicsSection: React.FC<DeclinedTopicsSectionProps> = ({ items, onAllowAgain }) => {
    const { t } = useTranslation();

    if (items.length === 0) return null;

    return (
        <GlassPanel className="mx-4 mb-3" fallbackClassName="bg-transparent">
            <VStack className="px-4 py-3" space="sm">
                <Text size="sm" bold className="text-white">
                    {t('facts.declinedTopicsTitle')}
                </Text>
                {items.map((item) => (
                    <HStack key={item.id} className="items-center justify-between">
                        <TranslatableDynamic
                            text={sentenceCase(item.text)}
                            size="sm"
                            className="text-gray-200 flex-1 mr-3"
                            numberOfLines={2}
                        />
                        <Button
                            variant="outline"
                            size="xs"
                            onPress={() => onAllowAgain(item)}
                            className="rounded-full"
                            testID={`declined-topic-allow-${item.id}`}
                            accessibilityLabel={t('facts.allowAgain')}
                        >
                            <ButtonText>{t('facts.allowAgain')}</ButtonText>
                        </Button>
                    </HStack>
                ))}
            </VStack>
        </GlassPanel>
    );
};

export default DeclinedTopicsSection;
