import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

interface CaughtUpDividerProps {
    /** `'empty-new'` when the top zone rendered no section cards (nothing new
     *  above the divider); `'normal'` otherwise. */
    readonly variant: 'normal' | 'empty-new';
    /** Number of previously-presented stories collapsed into the Earlier zone. */
    readonly earlierCount: number;
}

/**
 * Boundary between the "new" zone and the "Earlier" zone of the two-zone For-You
 * feed. Renders the "you're all caught up" marker (with a rule on each side),
 * then an "Earlier" sub-header carrying the count. In the `empty-new` variant
 * (nothing new above) the caught-up hint is omitted — there was nothing to catch
 * up on — so the divider reads as a plain header for the Earlier zone.
 */
const CaughtUpDivider: React.FC<CaughtUpDividerProps> = ({ variant, earlierCount }) => {
    const { t } = useTranslation();
    return (
        <VStack className="px-5 mt-1 mb-3">
            <HStack className="items-center my-2" space="sm">
                <Box className="flex-1" style={{ height: 1, backgroundColor: '#1f2937' }} />
                <MaterialIcons name="check-circle" size={16} color={ACCENT} />
                <Text size="sm" className="text-primary-400 font-semibold">
                    {t('forYou.caughtUp')}
                </Text>
                <Box className="flex-1" style={{ height: 1, backgroundColor: '#1f2937' }} />
            </HStack>

            {variant === 'normal' && (
                <Text size="xs" className="text-typography-500 text-center">
                    {t('forYou.caughtUpHint')}
                </Text>
            )}

            <HStack className="items-center justify-between mt-3">
                <Text size="lg" className="text-white font-bold">
                    {t('forYou.earlier')}
                </Text>
                <Text size="sm" className="text-typography-400">
                    {earlierCount}
                </Text>
            </HStack>
        </VStack>
    );
};

export default CaughtUpDivider;
