import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useAiAccess } from '@/lib/stores/subscription-store';
import { presentFreeTierPaywall } from '@/lib/subscription/present-free-tier-paywall';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export type FreeTierReadOnlySurface =
    | 'mera-protocol'
    | 'persona'
    | 'facts'
    | 'publications';

export interface FreeTierReadOnlyBannerProps {
    readonly surface: FreeTierReadOnlySurface;
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
export function useFreeTierReadOnly(): boolean {
    return useAiAccess() === 'locked';
}

/**
 * Pinned-bottom explanation for a screen whose controls `useFreeTierReadOnly`
 * has just disabled. Renders `null` when not locked, so screens can mount it
 * unconditionally.
 */
const FreeTierReadOnlyBanner: React.FC<FreeTierReadOnlyBannerProps> = ({
    surface,
    onSeePlans,
}) => {
    const { t } = useTranslation();
    const readOnly = useFreeTierReadOnly();

    const handleSeePlans = useCallback(async () => {
        if (onSeePlans) {
            onSeePlans();
            return;
        }
        await presentFreeTierPaywall('FreeTierReadOnlyBanner');
    }, [onSeePlans]);

    if (!readOnly) return null;

    return (
        <HStack
            testID="free-tier-readonly-banner"
            accessibilityLabel={`free-tier-readonly-${surface}`}
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
                    {t('freeTier.readOnlyBanner')}
                </Text>
                <Pressable onPress={handleSeePlans} hitSlop={8}>
                    <Text size="sm" className="text-primary-400 font-medium">
                        {t('freeTier.seePlans')}
                    </Text>
                </Pressable>
            </VStack>
        </HStack>
    );
};

export default FreeTierReadOnlyBanner;
