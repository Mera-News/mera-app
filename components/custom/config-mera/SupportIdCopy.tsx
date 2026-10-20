import { requestMoveToPhone } from '@/components/custom/auth/move-to-phone';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { maskEmail } from '@/lib/algorithms/mask-email';
import { authClient } from '@/lib/auth-client';
import { getSetting } from '@/lib/database/services/setting-service';
import { hapticLight } from '@/lib/haptics';
import { useUserStore } from '@/lib/stores/user-store';
import { resolveAccountEmailView } from '@/lib/subscription/email-capture';
import { accountHandle, resolveSupportId, type AccountHandle } from '@/lib/support-id';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Who this account is, for support: the Support ID (the session's, else the
 *  copy saved on this phone, so it shows offline), else an old email account's
 *  real email. Null hides the UI. */
export function useAccountHandle(): AccountHandle | null {
    const { data: session } = authClient.useSession();
    const storedEmail = useUserStore((s) => s.userEmail);
    const [cached, setCached] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        getSetting('cached_support_id')
            .then((v) => { if (live) setCached(v); })
            .catch(() => undefined);
        return () => { live = false; };
    }, []);
    const sessionUser = session?.user ?? null;
    const { displayEmail } = resolveAccountEmailView({ storedEmail, sessionUser });
    return accountHandle(resolveSupportId(sessionUser, cached), displayEmail ?? null);
}

interface Props {
    /** The text's testID; the button beside it is `${testID}-copy` or `${testID}-move`. */
    testID: string;
    /** A row's sub-line: one text line tall, the button's 44pt target kept by hitSlop. */
    compact?: boolean;
}

/** "Support ID: 1234567" with a copy button, or, for an email account that has
 *  no Support ID yet, its masked email with a "!" that opens the move dialog. */
const SupportIdCopy: React.FC<Props> = ({ testID, compact = false }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const handle = useAccountHandle();

    const [copied, setCopied] = useState(false);
    const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
        () => () => {
            if (copyTimer.current) clearTimeout(copyTimer.current);
        },
        [],
    );
    const handleCopy = async (value: string) => {
        try {
            await Clipboard.setStringAsync(value);
        } catch {
            return;
        }
        void hapticLight();
        setCopied(true);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 1800);
    };

    if (!handle) return null;

    const isEmail = handle.kind === 'email';
    const label = isEmail ? maskEmail(handle.value) : t('support.supportId', { id: handle.value });
    const target = compact
        ? { style: { minHeight: 20, minWidth: 44 }, hitSlop: { top: 12, bottom: 12 } }
        : { style: { minHeight: 44, minWidth: 44 } };
    return (
        <HStack accessible={false} space="sm" className="items-center">
            {compact ? (
                <Text testID={testID} selectable={!isEmail} style={{ color: colors.ink2, fontSize: 13, lineHeight: 18 }}>
                    {label}
                </Text>
            ) : (
                <Text testID={testID} selectable={!isEmail} size="sm" className="text-ink">
                    {label}
                </Text>
            )}
            {isEmail ? (
                <Pressable
                    testID={`${testID}-move`}
                    onPress={() => requestMoveToPhone()}
                    accessible
                    accessibilityRole="button"
                    accessibilityLabel={t('moveToPhone.settingsRow')}
                    className="items-center justify-center"
                    {...target}
                >
                    <MaterialIcons name="error-outline" size={18} color={colors.accentMark} />
                </Pressable>
            ) : (
                <Pressable
                    testID={`${testID}-copy`}
                    onPress={() => {
                        void handleCopy(handle.value);
                    }}
                    accessible
                    accessibilityRole="button"
                    accessibilityLabel={copied ? t('support.copied') : t('support.copySupportId')}
                    className="items-center justify-center"
                    {...target}
                >
                    {copied ? (
                        <Text size="sm" className="text-primary-400">
                            {t('support.copied')}
                        </Text>
                    ) : (
                        <MaterialIcons name="content-copy" size={16} color={colors.ink2} />
                    )}
                </Pressable>
            )}
        </HStack>
    );
};

export default SupportIdCopy;
