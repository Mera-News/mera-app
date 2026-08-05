import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import logger from '@/lib/logger';
import { getOfferingSafe } from '@/lib/revenuecat';
import { useAiAccess } from '@/lib/stores/subscription-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import RevenueCatUI from 'react-native-purchases-ui';

export type CompanionReadOnlySurface =
    | 'mera-protocol'
    | 'persona'
    | 'facts'
    | 'publications';

export interface CompanionReadOnlyBannerProps {
    readonly surface: CompanionReadOnlySurface;
    /** Defaults to presenting the RevenueCat paywall. */
    readonly onSeePlans?: () => void;
}

/**
 * Whether the AI settings screens are read-only.
 *
 * DISABLE, never hide. These screens show the user their own facts, topics and
 * preferences — hiding them behind a plan would break the same data-ownership
 * promise the rest of this mode is built on. What a plan buys is Mera ACTING on
 * these settings, so what a lapsed plan takes away is the ability to change
 * them, nothing more.
 *
 * `'unknown'` is not read-only: a paying user must not find their switches
 * frozen for the first second of a cold start.
 */
export function useCompanionReadOnly(): boolean {
    return useAiAccess() === 'locked';
}

/**
 * Pinned-bottom explanation for a screen whose controls `useCompanionReadOnly`
 * has just disabled. Renders `null` when not locked, so screens can mount it
 * unconditionally.
 */
const CompanionReadOnlyBanner: React.FC<CompanionReadOnlyBannerProps> = ({
    surface,
    onSeePlans,
}) => {
    const { t } = useTranslation();
    const readOnly = useCompanionReadOnly();

    const handleSeePlans = useCallback(async () => {
        if (onSeePlans) {
            onSeePlans();
            return;
        }
        try {
            const offering = await getOfferingSafe();
            await RevenueCatUI.presentPaywall({
                ...(offering ? { offering } : {}),
                displayCloseButton: true,
            });
        } catch (error) {
            logger.captureException(error, {
                tags: { component: 'CompanionReadOnlyBanner', method: 'seePlans' },
            });
        }
    }, [onSeePlans]);

    if (!readOnly) return null;

    return (
        <HStack
            testID="companion-readonly-banner"
            accessibilityLabel={`companion-readonly-${surface}`}
            space="sm"
            className="items-start px-4 py-3 border-t border-white/10 bg-black/60"
        >
            <MaterialIcons
                name="lock-outline"
                size={18}
                color="rgb(156, 163, 175)"
                style={{ marginTop: 2 }}
            />
            <VStack space="xs" className="flex-1">
                <Text size="sm" className="text-gray-300">
                    {t('companion.readOnlyBanner')}
                </Text>
                <Pressable onPress={handleSeePlans} hitSlop={8}>
                    <Text size="sm" className="text-primary-400 font-medium">
                        {t('companion.seePlans')}
                    </Text>
                </Pressable>
            </VStack>
        </HStack>
    );
};

export default CompanionReadOnlyBanner;
