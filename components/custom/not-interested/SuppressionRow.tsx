import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type PersonaSuppressionModel from '@/lib/database/models/PersonaSuppression';
import type { PersonaSuppressionKind } from '@/lib/database/models/PersonaSuppression';
import { HARD_SUPPRESSION_STRENGTH, kindOf } from '@/lib/database/services/suppression-service';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

type IconName = React.ComponentProps<typeof MaterialIcons>['name'];

const ACCENT = '#EDA77E';
const MUTED = 'rgb(115,115,115)';
const SUBTLE = 'rgb(163,163,163)';

/** One glyph per filter kind, so the row reads without opening it. */
const KIND_ICON: Record<PersonaSuppressionKind, IconName> = {
    keyword: 'format-quote',
    category: 'category',
    event_type: 'bolt',
    entity: 'person',
    place: 'place',
    publication: 'article',
    topic: 'label',
};

/** Suppression `source` → a notInterested.sources.* key (unknown ⇒ fallback). */
function sourceKey(source: string): string {
    switch (source) {
        case 'user':
        case 'chat':
        case 'feedback':
        case 'digest':
        case 'qa':
            return source;
        default:
            return 'unknown';
    }
}

interface SuppressionRowProps {
    readonly suppression: PersonaSuppressionModel;
    readonly isExpanded: boolean;
    readonly busy: boolean;
    readonly onToggle: (id: string) => void;
    readonly onRemove: (suppression: PersonaSuppressionModel) => void;
}

/**
 * One "not interested" filter. The header is the whole tap target; the detail
 * (kind, where it came from, when it lapses, Remove) is a SIBLING below it —
 * never a descendant — so the Remove control stays its own accessibility
 * element instead of being merged into the row's.
 */
const SuppressionRow: React.FC<SuppressionRowProps> = ({
    suppression,
    isExpanded,
    busy,
    onToggle,
    onRemove,
}) => {
    const { t } = useTranslation();
    const kind = kindOf(suppression);
    const isHard = suppression.strength >= HARD_SUPPRESSION_STRENGTH;
    const display = suppression.value ?? suppression.pattern;
    const expiresAt = suppression.expiresAt;

    return (
        <View className="border-b border-gray-800">
            <Pressable
                testID={`not-interested-row-${suppression.id}`}
                onPress={() => onToggle(suppression.id)}
                accessibilityRole="button"
                accessibilityLabel={display}
                accessibilityState={{ expanded: isExpanded }}
                className="flex-row items-center px-4 py-3"
            >
                <MaterialIcons name={KIND_ICON[kind]} size={18} color={ACCENT} />
                <TranslatableDynamic
                    text={display}
                    size="md"
                    className="text-white flex-1 ml-3 mr-2 capitalize"
                    numberOfLines={2}
                />
                <View
                    className="rounded-full px-2 py-0.5 mr-1"
                    style={{ backgroundColor: isHard ? 'rgba(239,68,68,0.18)' : 'rgba(115,115,115,0.25)' }}
                >
                    <Text size="xs" style={{ color: isHard ? '#f87171' : SUBTLE }}>
                        {isHard ? t('notInterested.badgeBlocked') : t('notInterested.badgeShownLess')}
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
                    <HStack className="items-center flex-wrap mb-2" space="xs">
                        <View className="border border-gray-700 rounded-full px-2 py-0.5">
                            <Text size="xs" style={{ color: SUBTLE }}>
                                {t(`notInterested.kinds.${kind}` as never)}
                            </Text>
                        </View>
                        <View className="border border-gray-700 rounded-full px-2 py-0.5">
                            <Text size="xs" style={{ color: SUBTLE }}>
                                {t(`notInterested.sources.${sourceKey(suppression.source)}` as never)}
                            </Text>
                        </View>
                        <Text size="xs" style={{ color: MUTED }}>
                            {expiresAt
                                ? t('notInterested.expiresOn', {
                                      date: new Date(expiresAt).toLocaleDateString(),
                                  })
                                : t('notInterested.expiresNever')}
                        </Text>
                    </HStack>
                    <Pressable
                        testID="not-interested-row-remove"
                        onPress={() => onRemove(suppression)}
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

export default SuppressionRow;
