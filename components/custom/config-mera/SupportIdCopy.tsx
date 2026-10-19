import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { authClient } from '@/lib/auth-client';
import { getSetting } from '@/lib/database/services/setting-service';
import { hapticLight } from '@/lib/haptics';
import { resolveSupportId } from '@/lib/support-id';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** The account's Support ID: the session's, else the copy saved on this phone,
 *  so it still shows offline or with a dead session. Null hides the UI. */
export function useSupportId(): string | null {
    const { data: session } = authClient.useSession();
    const [cached, setCached] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        getSetting('cached_support_id')
            .then((v) => { if (live) setCached(v); })
            .catch(() => undefined);
        return () => { live = false; };
    }, []);
    return resolveSupportId(session?.user ?? null, cached);
}

interface Props {
    /** The text's testID; the copy button is `${testID}-copy`. */
    testID: string;
    /** The Settings footer's small grey line instead of the card's body text. */
    footer?: boolean;
}

/** "Support ID: 1234567" with a copy button. Renders nothing without an id. */
const SupportIdCopy: React.FC<Props> = ({ testID, footer = false }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const supportId = useSupportId();

    const [copied, setCopied] = useState(false);
    const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
        () => () => {
            if (copyTimer.current) clearTimeout(copyTimer.current);
        },
        [],
    );
    const handleCopy = async () => {
        if (!supportId) return;
        try {
            await Clipboard.setStringAsync(supportId);
        } catch {
            return;
        }
        void hapticLight();
        setCopied(true);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 1800);
    };

    if (!supportId) return null;

    const label = t('support.supportId', { id: supportId });
    return (
        <HStack accessible={false} space="sm" className={footer ? 'items-center justify-center' : 'items-center'}>
            {footer ? (
                <Text testID={testID} selectable style={{ color: colors.ink3, fontSize: 12 }}>
                    {label}
                </Text>
            ) : (
                <Text testID={testID} selectable size="sm" className="text-ink">
                    {label}
                </Text>
            )}
            <Pressable
                testID={`${testID}-copy`}
                onPress={() => {
                    void handleCopy();
                }}
                accessible
                accessibilityRole="button"
                accessibilityLabel={copied ? t('support.copied') : t('support.copySupportId')}
                className="items-center justify-center"
                style={{ minHeight: 44, minWidth: 44 }}
            >
                {copied ? (
                    <Text size="sm" className="text-primary-400">
                        {t('support.copied')}
                    </Text>
                ) : (
                    <MaterialIcons name="content-copy" size={footer ? 14 : 16} color={footer ? colors.ink3 : colors.ink2} />
                )}
            </Pressable>
        </HStack>
    );
};

export default SupportIdCopy;
