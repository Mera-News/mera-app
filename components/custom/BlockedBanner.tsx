import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useSupportAction } from '@/lib/intercom';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface BlockedBannerProps {
    reason?: string | null;
}

const BlockedBanner: React.FC<BlockedBannerProps> = ({ reason }) => {
    const { t } = useTranslation();
    const { busy: supportBusy, openSupport } = useSupportAction();

    return (
        <Box className="mx-4 my-2 p-4 rounded-xl bg-red-900/30 border border-red-800/50">
            <HStack className="items-center" space="sm">
                <MaterialIcons name="block" size={20} color="#F87171" />
                <Box className="flex-1">
                    <Text className="text-red-400 font-semibold" size="sm">
                        {t('errors.accountRestricted')}
                    </Text>
                    <Text className="text-red-300/80 mt-1" size="xs">
                        {reason || t('errors.accountRestrictedDescription')}
                    </Text>

                    {/* The affordance the copy has always promised ("Please
                        contact support") but never had.

                        A SIBLING of the reason text, not a touchable wrapped
                        around the whole banner: `reason` is server-supplied
                        prose the user may well want to read carefully and
                        select, and swallowing it into a button takes that away.

                        Real height rather than hitSlop, because this control
                        sits inside a dense banner where a hitSlop would overlap
                        the selectable text above it.

                        "Message support", NOT "Request a review". The actual
                        appeal mechanism is RequestUnblockModal, which needs a
                        conversationId and is only mounted from ChatSessionView,
                        so it is structurally unreachable from here. A support
                        conversation creates no requestUnblock record and never
                        enters the moderation queue. A human can still help, so
                        the control earns its place — but it must not promise a
                        review it cannot deliver. */}
                    <Pressable
                        onPress={() => { void openSupport(); }}
                        accessibilityRole="button"
                        accessibilityState={supportBusy ? { busy: true } : undefined}
                        accessibilityLabel={
                            supportBusy
                                ? t('support.opening')
                                : t('errors.accountRestrictedContact')
                        }
                        className="mt-3 self-start min-h-[44px] justify-center px-3 rounded-lg border border-red-700/60"
                    >
                        {supportBusy ? (
                            <Spinner size="small" />
                        ) : (
                            <Text className="text-red-300 font-medium" size="xs">
                                {t('errors.accountRestrictedContact')}
                            </Text>
                        )}
                    </Pressable>
                </Box>
            </HStack>
        </Box>
    );
};

export default BlockedBanner;
