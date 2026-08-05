import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import {
    IMPORTANCE_THRESHOLDS,
    type ImportanceThreshold,
} from '@/lib/feed-ordering/importance-filter';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

interface ImportanceFilterPillsProps {
    readonly value: ImportanceThreshold;
    readonly onChange: (threshold: ImportanceThreshold) => void;
    /** e.g. 'feed-importance' → testIDs `feed-importance-{high|medium|low}`. */
    readonly testIDPrefix: string;
}

// Reuses the RelevanceChip label keys so the pills and the worded chip on each
// card can never disagree ("Med" pill hides cards chipped "Med" would be a
// visible contradiction).
const LABEL_KEYS: Record<ImportanceThreshold, string> = {
    high: 'relevance.high',
    medium: 'relevance.medium',
    low: 'relevance.low',
};

/**
 * The importance-threshold pill row `[High] [Med] [Low]` — a minimum-band
 * radio, compact enough to sit inside a screen-title header row. Presentational
 * only: each surface owns its threshold in `importance-filter-store` and passes
 * it down, because Feed and Dashboard persist SEPARATE values with separate
 * defaults.
 *
 * Styling mirrors ForYouSubTabs / ScopeChipRow (accent-filled active pill) at
 * the compact size. The wrapper is box-none per the header pull-to-refresh
 * rule — only the pills themselves take touches.
 */
const ImportanceFilterPills: React.FC<ImportanceFilterPillsProps> = ({
    value,
    onChange,
    testIDPrefix,
}) => {
    const { t } = useTranslation();

    return (
        <View
            testID={testIDPrefix}
            pointerEvents="box-none"
            accessibilityLabel={t('importanceFilter.a11yLabel')}
        >
            <HStack className="items-center" space="xs">
                {IMPORTANCE_THRESHOLDS.map((threshold) => {
                    const active = threshold === value;
                    return (
                        <Pressable
                            key={threshold}
                            onPress={() => onChange(threshold)}
                            accessibilityRole="button"
                            accessibilityState={{ selected: active }}
                            accessibilityLabel={t('importanceFilter.a11yOption', {
                                level: t(LABEL_KEYS[threshold] as any),
                            })}
                            testID={`${testIDPrefix}-${threshold}`}
                            className={`rounded-full border px-2.5 py-1 ${
                                active
                                    ? 'bg-primary-400 border-primary-400'
                                    : 'border-primary-500 bg-transparent'
                            }`}
                        >
                            <Text
                                size="xs"
                                numberOfLines={1}
                                className={
                                    active
                                        ? 'text-black font-semibold'
                                        : 'text-primary-500 font-semibold'
                                }
                            >
                                {t(LABEL_KEYS[threshold] as any)}
                            </Text>
                        </Pressable>
                    );
                })}
            </HStack>
        </View>
    );
};

export default ImportanceFilterPills;
