import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { authClient } from '@/lib/auth-client';
import { PRIVACY_URL } from '@/lib/config/branding';
import { useUserStore } from '@/lib/stores/user-store';
import { emailLooksAnonymous } from '@/lib/subscription/email-capture';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import { useColors } from '@/lib/theme/tokens';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';
import SupportIdCopy from './SupportIdCopy';

/** Which account the card describes. `unknown` covers a store that has not
 *  hydrated and an offline launch with no session: the card then shows the
 *  generic list rather than guessing, and never a spinner or an error. */
export type KeepsAccountKind = 'email' | 'no-email' | 'unknown';

interface SessionUserLike {
    email?: string | null;
    isAnonymous?: boolean | null;
}

/**
 * Decide the account kind from what is on hand. A REAL stored email wins (it
 * is written only by an email sign-in or a confirmed attach); otherwise a
 * resolved session decides; with neither, the answer is unknown. A merely
 * missing email never counts as "no email", because offline an email account
 * can look exactly like that.
 */
export function keepsAccountKind(
    storedEmail: string | null | undefined,
    sessionUser: SessionUserLike | null | undefined,
): KeepsAccountKind {
    if (storedEmail && !emailLooksAnonymous(storedEmail)) return 'email';
    if (sessionUser) {
        if (sessionUser.isAnonymous === true) return 'no-email';
        if (sessionUser.email) return emailLooksAnonymous(sessionUser.email) ? 'no-email' : 'email';
    }
    return 'unknown';
}

export type KeepsLineKey =
    | 'manageData.keeps.emailAndPlan'
    | 'manageData.keeps.plan'
    | 'manageData.keeps.emailIfAdded'
    | 'manageData.keeps.signInRecordIos'
    | 'manageData.keeps.signInRecordAndroid'
    | 'manageData.keeps.signInRecordGeneric'
    | 'manageData.keeps.usage'
    | 'manageData.keeps.topics';

/** The lines the card lists for an account kind, in order. At most four. */
export function keepsLineKeys(kind: KeepsAccountKind, platform: string): KeepsLineKey[] {
    const signInRecord: KeepsLineKey =
        platform === 'ios'
            ? 'manageData.keeps.signInRecordIos'
            : 'manageData.keeps.signInRecordAndroid';
    switch (kind) {
        case 'email':
            return ['manageData.keeps.emailAndPlan', 'manageData.keeps.usage', 'manageData.keeps.topics'];
        case 'no-email':
            return [
                'manageData.keeps.plan',
                signInRecord,
                'manageData.keeps.usage',
                'manageData.keeps.topics',
            ];
        default:
            return [
                'manageData.keeps.emailIfAdded',
                'manageData.keeps.signInRecordGeneric',
                'manageData.keeps.usage',
                'manageData.keeps.topics',
            ];
    }
}

/**
 * "What Mera keeps about you": one collapsed row on Manage data, below the
 * backup section, expanding to a plain list of what the server keeps for THIS
 * account, the Support ID, and the privacy policy. Neutral, not red: nothing
 * here deletes anything.
 *
 * Lives in its own file so ManageDataScreen.test.tsx can stub it the way it
 * stubs BackupSection; this component reaches auth-client, the clipboard and
 * the user store.
 */
const WhatMeraKeepsCard: React.FC = () => {
    const { t } = useTranslation();
    const colors = useColors();
    const [expanded, setExpanded] = useState(false);
    const storedEmail = useUserStore((s) => s.userEmail);
    const { data: session } = authClient.useSession();
    const sessionUser = (session?.user ?? null) as SessionUserLike | null;

    const kind = keepsAccountKind(storedEmail, sessionUser);
    const lines = keepsLineKeys(kind, Platform.OS);

    const title = t('manageData.keeps.title');

    return (
        <Box testID="manage-data-keeps" className="mb-4 rounded-lg border border-line">
            <Pressable
                testID="manage-data-keeps-toggle"
                onPress={() => setExpanded((v) => !v)}
                accessible
                accessibilityRole="button"
                accessibilityLabel={title}
                accessibilityState={{ expanded }}
                className="flex-row items-center justify-between py-3 px-4"
                style={{ minHeight: 44 }}
            >
                <HStack space="md" className="items-center flex-1">
                    <MaterialIcons name="privacy-tip" size={22} color={colors.ink2} />
                    <Text className="text-base text-ink flex-1">{title}</Text>
                </HStack>
                <MaterialIcons
                    name={expanded ? 'expand-less' : 'expand-more'}
                    size={22}
                    color={colors.ink3}
                />
            </Pressable>

            {expanded ? (
                <VStack testID="manage-data-keeps-body" space="sm" className="px-4 pb-4">
                    {lines.map((key) => (
                        <Text
                            key={key}
                            testID={`manage-data-keeps-line-${key.split('.').pop()}`}
                            size="sm"
                            className="text-ink"
                        >
                            {t(key)}
                        </Text>
                    ))}

                    <SupportIdCopy testID="manage-data-keeps-support-id" />

                    <Pressable
                        testID="manage-data-keeps-privacy"
                        onPress={() => openInAppBrowser(withAppLanguage(PRIVACY_URL))}
                        accessible
                        accessibilityRole="link"
                        accessibilityLabel={t('manageData.keeps.privacyLink')}
                        className="justify-center self-start"
                        style={{ minHeight: 44 }}
                    >
                        <Text size="sm" className="text-primary-500 font-semibold">
                            {t('manageData.keeps.privacyLink')}
                        </Text>
                    </Pressable>
                </VStack>
            ) : null}
        </Box>
    );
};

export default WhatMeraKeepsCard;
