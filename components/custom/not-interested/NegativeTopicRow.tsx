import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type TopicModel from '@/lib/database/models/Topic';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

const ACCENT = '#EDA77E';
const SUBTLE = 'rgb(163,163,163)';

interface NegativeTopicRowProps {
    readonly topic: TopicModel;
    readonly isExpanded: boolean;
    readonly busy: boolean;
    readonly onToggle: (id: string) => void;
    readonly onRemove: (topic: TopicModel) => void;
}

/**
 * A topic the user pushed below zero (or suppressed outright). Same
 * tap-to-reveal shape as SuppressionRow — header is the tap target, the Remove
 * control is a sibling below it, not a nested pressable.
 */
const NegativeTopicRow: React.FC<NegativeTopicRowProps> = ({
    topic,
    isExpanded,
    busy,
    onToggle,
    onRemove,
}) => {
    const { t } = useTranslation();
    const isSuppressed = topic.status === 'suppressed';

    return (
        <View className="border-b border-gray-800">
            <Pressable
                testID={`not-interested-row-${topic.id}`}
                onPress={() => onToggle(topic.id)}
                accessibilityRole="button"
                accessibilityLabel={topic.text}
                accessibilityState={{ expanded: isExpanded }}
                className="flex-row items-center px-4 py-3"
            >
                <MaterialIcons name="label" size={18} color={ACCENT} />
                <TranslatableDynamic
                    text={topic.text}
                    size="md"
                    className="text-white flex-1 ml-3 mr-2 capitalize"
                    numberOfLines={2}
                />
                <View className="rounded-full px-2 py-0.5 mr-1 bg-gray-700">
                    <Text size="xs" style={{ color: SUBTLE }}>
                        {isSuppressed
                            ? t('notInterested.badgeBlocked')
                            : t('notInterested.badgeMutedTopic')}
                    </Text>
                </View>
                <MaterialIcons
                    name={isExpanded ? 'expand-less' : 'expand-more'}
                    size={20}
                    color="#9ca3af"
                />
            </Pressable>

            {isExpanded ? (
                <View testID="not-interested-row-detail" className="px-4 pb-3">
                    <Pressable
                        testID="not-interested-row-remove"
                        onPress={() => onRemove(topic)}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel={t('notInterested.remove')}
                        className="self-start flex-row items-center border border-gray-700 rounded-full px-3 py-1"
                    >
                        <MaterialIcons name="close" size={13} color={ACCENT} />
                        <Text size="xs" className="ml-1" style={{ color: ACCENT }}>
                            {t('notInterested.remove')}
                        </Text>
                    </Pressable>
                </View>
            ) : null}
        </View>
    );
};

export default NegativeTopicRow;
