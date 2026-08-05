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

export type CompanionNoticeSurface = 'chat' | 'stories-header' | 'settings-row';

export interface CompanionInlineNoticeProps {
    readonly surface: CompanionNoticeSurface;
    /** Defaults to presenting the RevenueCat paywall. */
    readonly onSeePlans?: () => void;
}

/**
 * One quiet row: icon, one sentence, "See plans".
 *
 * This is what stands in the place a chat invite or a track affordance would
 * have occupied. Rendering nothing there instead would read as a bug — a row
 * that silently vanished — where a sentence reads as a decision.
 *
 * Each surface gets its own sentence because each one is answering a different
 * question the user just asked by arriving there.
 *
 * `as const` on the key map is load-bearing: `t` is typed against the literal
 * union generated from en.json, so a widened `string` would not type-check and
 * a typo'd key would render as a raw path on a device instead of failing here.
 */
const NOTICE_KEY = {
    chat: 'companion.chatNotice',
    'stories-header': 'companion.storiesNotice',
    'settings-row': 'companion.settingsRowNotice',
} as const satisfies Record<CompanionNoticeSurface, string>;

const CompanionInlineNotice: React.FC<CompanionInlineNoticeProps> = ({
    surface,
    onSeePlans,
}) => {
    const { t } = useTranslation();
    const aiAccess = useAiAccess();

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
                tags: { component: 'CompanionInlineNotice', method: 'seePlans' },
            });
        }
    }, [onSeePlans]);

    if (aiAccess !== 'locked') return null;

    return (
        <HStack
            testID={`companion-notice-${surface}`}
            space="sm"
            className="items-start px-4 py-3 rounded-xl border border-white/10 bg-white/5"
        >
            <MaterialIcons
                name="auto-awesome"
                size={18}
                color="rgb(231, 138, 83)"
                style={{ marginTop: 2 }}
            />
            <VStack space="xs" className="flex-1">
                <Text size="sm" className="text-gray-300">
                    {t(NOTICE_KEY[surface])}
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

export default CompanionInlineNotice;
