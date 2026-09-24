import { GlassPanel } from '@/components/custom/GlassSurface';
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
    /**
     * Glyph inside that button. Defaults to the upgrade arrow, so the two call
     * sites that really do open a paywall (ManageSubscriptionScreen, the persona
     * tab) are unchanged. Profile overrides it because its pill navigates to
     * subscription management rather than selling anything, and an up-arrow on a
     * "Manage" button points at an action that isn't happening.
     */
    upgradeIcon?: React.ComponentProps<typeof MaterialIcons>['name'];
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
    upgradeIcon = 'arrow-upward',
    resetAt,
    resetLabel,
    onInfoPress,
    className,
}) => {
    const { t, i18n } = useTranslation();

    const hasLimit = typeof limit === 'number' && limit > 0;
    // Grouped in the app language: "10,000", not "10000" (M9). A malformed
    // language tag throws in some Hermes builds, so the bare number is the
    // fallback rather than a crash on the usage card.
    const formatCount = (n: number): string => {
        try {
            return n.toLocaleString(i18n.language);
        } catch {
            return String(n);
        }
    };
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
        <GlassPanel
            radius={16}
            className={className ?? ''}
            contentClassName="p-5"
            fallbackClassName="bg-gray-900 border border-gray-800"
        >
            {/* Stacked, not side by side (C-PRO): with the plan chip beside it
                the figure wrapped ("1,123 /" over "10,000") and the label was
                cut off. The figure and its label own the full width; the plan,
                its button and the reset time get their own rows below. */}
            <VStack className="mb-3">
                {/* No `leading-9` (1.2 on 30px type): `text-3xl` carries a
                    script-safe line box, and a tight override is how clipping
                    comes back the moment a localized string lands here. */}
                <Text className="text-white font-bold text-3xl" numberOfLines={1} testID="usage-widget-figure">
                    {formatCount(used)}
                    {hasLimit ? (
                        <Text className="text-gray-400 font-semibold text-xl"> / {formatCount(limit as number)}</Text>
                    ) : null}
                </Text>
                <HStack className="items-center mt-0.5" space="xs">
                    <Text size="xs" className="text-gray-300 font-medium flex-shrink" numberOfLines={2}>{usedLabel}</Text>
                    {onInfoPress ? (
                        <Pressable onPress={onInfoPress} hitSlop={14} accessibilityRole="button">
                            <MaterialIcons name="info-outline" size={14} color="#9ca3af" />
                        </Pressable>
                    ) : null}
                </HStack>
            </VStack>
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
            {(planLabel || onUpgrade) ? (
                <HStack className="items-center justify-between mt-4" space="sm">
                    {planLabel ? (
                        <Text size="sm" className="text-primary-400 font-semibold flex-shrink" numberOfLines={2}>{planLabel}</Text>
                    ) : <Box />}
                    {onUpgrade ? (
                        <Pressable
                            onPress={onUpgrade}
                            accessibilityRole="button"
                            style={{ minHeight: 44, justifyContent: 'center' }}
                            className="bg-primary-500 rounded-full px-4"
                        >
                            <HStack className="items-center" space="xs">
                                <MaterialIcons name={upgradeIcon} size={14} color="#ffffff" />
                                {upgradeLabel ? (
                                    <Text size="sm" className="text-white font-semibold">{upgradeLabel}</Text>
                                ) : null}
                            </HStack>
                        </Pressable>
                    ) : null}
                </HStack>
            ) : null}
            {resetText ? (
                <Text size="xs" className="text-gray-300 font-medium mt-2">
                    {resetLabel} <Text size="xs" className="text-gray-100 font-semibold">{resetText}</Text>
                </Text>
            ) : null}
        </GlassPanel>
    );
};

export default UsageWidget;
