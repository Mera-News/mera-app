import { useCallback, useEffect, useState } from 'react';
import { BackHandler, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Button, ButtonText } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { authClient } from '@/lib/auth-client';
import { PRIVACY_URL, TERMS_URL } from '@/lib/config/branding';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';
import {
    acceptLegal,
    fetchLegalVersions,
    needsConsent,
    type ConsentSessionUser,
    type LegalVersions,
} from './legal-consent';

/**
 * Blocking, regulatory consent gate. Mounted ONCE at the logged-in layout
 * root, LAST among its siblings so it paints over everything else there
 * (FloatingChatHost, the feedback modal, the lapse/first-open subscription
 * gates).
 *
 * Deliberately diverges from LapseInterstitialGate / FirstOpenPaywallGate in
 * two ways:
 *  - it renders an IN-PLACE full-screen overlay rather than navigating, so it
 *    can never be stomped by the logged-in index's own `router.replace()` —
 *    the exact race those two gates work around with a post-navigation
 *    settle timer, and one this gate sidesteps entirely by not navigating;
 *  - it carries NO `pathname.includes('/logged-in/app_container')` filter —
 *    consent outranks onboarding and the paywall alike, so it can block on
 *    any route under `/logged-in`, not just the tab shell.
 *
 * Fails OPEN, matching NativeUpdateGate's precedent: an unreachable
 * `appConfig` query, a pending session, or a signed-out tree never blocks.
 * This is a regulatory prompt, not an identity gate (see the "never silent
 * logout" rule) — failing open just means one more re-prompt on the next
 * successful check, never a stranded user.
 */
export default function ConsentGate() {
    const { t } = useTranslation();
    const { data: session, isPending } = authClient.useSession();
    const userId = session?.user?.id ?? null;

    const [current, setCurrent] = useState<LegalVersions | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(false);

    // Latches true once THIS session has accepted, and stands the gate down
    // for the rest of the process regardless of what the next
    // `authClient.useSession()` read reports. better-auth-expo caches
    // `session_data` locally (see lib/auth-client.ts's note on the exact keys
    // it persists) and there is no guarantee the freshly-accepted
    // termsVersion/privacyVersion are visible on the very next read —
    // re-deriving "needed?" purely from that cache after a successful accept
    // would re-show this screen with no way out.
    const [accepted, setAccepted] = useState(false);

    // A different account (or a fresh sign-in) gets its own consent check —
    // the latch is per-session, not a permanent "never ask again".
    useEffect(() => {
        setAccepted(false);
        setError(false);
        setCurrent(null);
    }, [userId]);

    useEffect(() => {
        if (!userId) return;
        let cancelled = false;
        void fetchLegalVersions().then((versions) => {
            if (!cancelled) setCurrent(versions);
        });
        return () => {
            cancelled = true;
        };
    }, [userId]);

    const user = session?.user as ConsentSessionUser | undefined;
    const shown = !isPending && !accepted && needsConsent(user, current);

    const handleAccept = useCallback(async () => {
        if (!current) return;
        setBusy(true);
        setError(false);
        const result = await acceptLegal(current);
        setBusy(false);
        if (result.ok) {
            setAccepted(true);
        } else {
            setError(true);
        }
    }, [current]);

    // Swallow the Android hardware back button while shown — there is no
    // navigation out of this gate other than accepting.
    useEffect(() => {
        if (!shown) return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
        return () => subscription.remove();
    }, [shown]);

    if (!shown) return null;

    return (
        <View
            pointerEvents="auto"
            style={{
                position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100,
            }}
        >
            <View className="flex-1 items-center justify-center px-8">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else here. */}
                <AbstractGradientBackdrop />

                <Text className="text-white text-2xl font-bold text-center">
                    {t('consent.title')}
                </Text>
                <Text className="text-gray-300 text-base mt-3 text-center leading-relaxed">
                    {t('consent.body')}
                </Text>

                <VStack space="sm" className="mt-6 items-center">
                    <Pressable onPress={() => openInAppBrowser(withAppLanguage(TERMS_URL))}>
                        <Text className="text-primary-400 text-sm underline">
                            {t('consent.termsLink')}
                        </Text>
                    </Pressable>
                    <Pressable onPress={() => openInAppBrowser(withAppLanguage(PRIVACY_URL))}>
                        <Text className="text-primary-400 text-sm underline">
                            {t('consent.privacyLink')}
                        </Text>
                    </Pressable>
                </VStack>

                {error ? (
                    <Text className="text-red-400 text-sm text-center mt-4">
                        {t('consent.errorDescription')}
                    </Text>
                ) : null}

                <Button
                    testID="consent-accept"
                    onPress={handleAccept}
                    disabled={busy || !current}
                    className="mt-8 bg-white rounded-full px-8"
                    size="lg"
                >
                    {busy ? <Spinner size="small" className="mr-2" /> : null}
                    <ButtonText className="text-black">
                        {busy ? t('consent.accepting') : error ? t('consent.retry') : t('consent.accept')}
                    </ButtonText>
                </Button>
            </View>
        </View>
    );
}
