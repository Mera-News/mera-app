import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

const GREEN = '#10b981';
const AMBER = '#f59e0b';
const RED = '#ef4444';

// Fill color shifts green → amber → red as the daily quota is used up.
const usageColor = (used: number, limit: number): string => {
    if (limit <= 0) return GREEN;
    const ratio = used / limit;
    if (ratio < 0.7) return GREEN;
    if (ratio < 0.9) return AMBER;
    return RED;
};

interface UsageWidgetProps {
    /** Amount consumed (e.g. articles analyzed today). */
    used: number;
    /** Quota. When null/0 the bar is hidden and only the count is shown (offline fallback). */
    limit?: number | null;
    /** Caption shown under the big number, e.g. "Analyzed today". */
    usedLabel: string;
    /** Plan name shown top-right, e.g. "Individual" / "Promo" / "Free plan". */
    planLabel?: string | null;
    /** When set, an upgrade button is shown next to the plan name (opens the plans/paywall). */
    onUpgrade?: () => void;
    /** Text for the upgrade button, e.g. "Upgrade". */
    upgradeLabel?: string;
    /** ISO reset timestamp; formatted with the active locale. Row hidden unless resetLabel is also set. */
    resetAt?: string | null;
    /** Label for the reset row, e.g. "Resets". */
    resetLabel?: string;
    /** Optional ⓘ icon next to the caption (e.g. opens an explainer modal). */
    onInfoPress?: () => void;
    /** Extra classes for outer margins (e.g. "mx-4 mb-3"). */
    className?: string;
}

/**
 * Daily-usage card: a big "{used} / {limit}" figure with a colored progress
 * bar, an optional plan label + reset time on the right, and an optional info
 * icon. Shared by the Manage-subscription screen and the persona tab.
 */
const UsageWidget: React.FC<UsageWidgetProps> = ({
    used,
    limit,
    usedLabel,
    planLabel,
    onUpgrade,
    upgradeLabel,
    resetAt,
    resetLabel,
    onInfoPress,
    className,
}) => {
    const { i18n } = useTranslation();

    const hasLimit = typeof limit === 'number' && limit > 0;
    const pct = hasLimit ? Math.min(100, Math.round((used / (limit as number)) * 100)) : 0;

    const resetText = (() => {
        if (!resetAt || !resetLabel) return null;
        const date = new Date(resetAt);
        if (Number.isNaN(date.getTime())) return null;
        return date.toLocaleString(i18n.language, {
            hour: '2-digit',
            minute: '2-digit',
            month: 'short',
            day: 'numeric',
        });
    })();

    return (
        <Box className={`bg-gray-900 rounded-2xl p-5 border border-gray-800 ${className ?? ''}`}>
            <HStack className="items-start justify-between mb-3">
                <VStack className="flex-1">
                    <Text className="text-white font-bold text-3xl leading-9">
                        {used}
                        {hasLimit ? (
                            <Text className="text-gray-500 font-semibold text-xl"> / {limit}</Text>
                        ) : null}
                    </Text>
                    <HStack className="items-center mt-0.5" space="xs">
                        <Text size="xs" className="text-gray-500">{usedLabel}</Text>
                        {onInfoPress ? (
                            <Pressable onPress={onInfoPress} hitSlop={8}>
                                <MaterialIcons name="info-outline" size={14} color="#6b7280" />
                            </Pressable>
                        ) : null}
                    </HStack>
                </VStack>
                {(planLabel || resetText || onUpgrade) ? (
                    <VStack className="items-end ml-3">
                        <HStack className="items-center" space="xs">
                            {planLabel ? (
                                <Text size="xs" className="text-primary-400 font-semibold">{planLabel}</Text>
                            ) : null}
                            {onUpgrade ? (
                                <Pressable
                                    onPress={onUpgrade}
                                    hitSlop={8}
                                    className="bg-primary-500 rounded-full px-2.5 py-1"
                                >
                                    <HStack className="items-center" space="xs">
                                        <MaterialIcons name="arrow-upward" size={12} color="#ffffff" />
                                        {upgradeLabel ? (
                                            <Text size="xs" className="text-white font-semibold">{upgradeLabel}</Text>
                                        ) : null}
                                    </HStack>
                                </Pressable>
                            ) : null}
                        </HStack>
                        {resetText ? (
                            <>
                                <Text size="xs" className="text-gray-500 mt-1">{resetLabel}</Text>
                                <Text size="xs" className="text-gray-300">{resetText}</Text>
                            </>
                        ) : null}
                    </VStack>
                ) : null}
            </HStack>
            {hasLimit ? (
                <View style={{ height: 8, borderRadius: 4, backgroundColor: '#1f2937', overflow: 'hidden' }}>
                    <View
                        style={{
                            height: 8,
                            borderRadius: 4,
                            width: `${pct}%`,
                            backgroundColor: usageColor(used, limit as number),
                        }}
                    />
                </View>
            ) : null}
        </Box>
    );
};

export default UsageWidget;
