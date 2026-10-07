import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Button, ButtonText } from '@/components/ui/button';
import { useSupportAction } from '@/lib/intercom';
import { releaseSplash } from '@/lib/splash-hold';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useColors } from '@/lib/theme/tokens';

export type AccountGateVariant = 'offline' | 'unreachable';

interface AccountGateScreenProps {
    variant: AccountGateVariant;
    /** Run the launch account check again. */
    onRetry: () => void;
}

/** "Mera keeps trying" on the unreachable variant: this often, while shown. */
const UNREACHABLE_RETRY_MS = 20_000;

/**
 * The launch gate when Mera cannot confirm the account (FinalStart #6, #7): one
 * full screen, one way forward, never a banner over a half-working app. Shown
 * only on a DEFINITE answer (the phone says it is offline, or the server check
 * already failed with the server marked unreachable), never after a probe of
 * its own, so a normal launch pays nothing for it.
 *
 * It never signs anyone out (only the Log out button does). Offline continues
 * by itself on reconnect; unreachable retries on its own and on the server
 * answering again. Rendered IN PLACE on the gate's pathname, so it releases the
 * held splash itself.
 */
export default function AccountGateScreen({ variant, onRetry }: AccountGateScreenProps) {
    const { t } = useTranslation();
    const colors = useColors();
    const insets = useSafeAreaInsets();
    const { busy, openSupport } = useSupportAction();
    const isConnected = useNetworkStore((s) => s.isConnected);
    const serverReachable = useNetworkStore((s) => s.serverReachable);

    useEffect(() => {
        releaseSplash('account-gate');
    }, []);

    // Back online, or the server answering again: try at once.
    useEffect(() => {
        if (variant === 'offline' && isConnected) onRetry();
        if (variant === 'unreachable' && serverReachable) onRetry();
    }, [variant, isConnected, serverReachable, onRetry]);

    useEffect(() => {
        if (variant !== 'unreachable') return;
        const id = setInterval(onRetry, UNREACHABLE_RETRY_MS);
        return () => clearInterval(id);
    }, [variant, onRetry]);

    const offline = variant === 'offline';
    return (
        <View style={[styles.root, { backgroundColor: colors.base }]} testID={`account-gate-${variant}`}>
            <AbstractGradientBackdrop />
            <View style={[styles.body, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 32 }]}>
                <View style={styles.center}>
                    <View style={[styles.icon, { backgroundColor: colors.surface, borderColor: colors.line }]}>
                        <MaterialIcons name={offline ? 'cloud-off' : 'dns'} size={30} color={colors.ink2} />
                    </View>
                    <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
                        {t(offline ? 'gate.offlineTitle' : 'gate.unreachableTitle')}
                    </Text>
                    <Text style={[styles.text, { color: colors.ink2 }]}>
                        {t(offline ? 'gate.offlineBody' : 'gate.unreachableBody')}
                    </Text>
                </View>
                <View style={styles.actions}>
                    <Button action="primary" onPress={onRetry} className="w-full" testID="account-gate-retry">
                        <ButtonText>{t('auth.tryAgain')}</ButtonText>
                    </Button>
                    {offline ? (
                        <Text style={[styles.caption, { color: colors.ink3 }]}>{t('gate.opensByItself')}</Text>
                    ) : (
                        <Button
                            variant="outline"
                            action="secondary"
                            onPress={() => void openSupport()}
                            isDisabled={busy}
                            className="w-full"
                            testID="account-gate-help"
                        >
                            <ButtonText>{t('gate.getHelp')}</ButtonText>
                        </Button>
                    )}
                </View>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    body: { flex: 1, paddingHorizontal: 24, justifyContent: 'space-between' },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
    icon: {
        width: 64,
        height: 64,
        borderRadius: 32,
        borderWidth: StyleSheet.hairlineWidth,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 8,
    },
    title: { fontSize: 24, fontWeight: '700', textAlign: 'center' },
    text: { fontSize: 16, lineHeight: 22, textAlign: 'center' },
    actions: { gap: 12, alignItems: 'center' },
    caption: { fontSize: 14, textAlign: 'center' },
});
