import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import ConsentContent from '@/components/custom/auth/ConsentContent';
import { ScrollView } from '@/components/ui/scroll-view';
import { Text } from '@/components/ui/text';
import { authClient } from '@/lib/auth-client';
import {
    acceptLegal,
    fetchLegalVersions,
    markLegalAcceptedThisProcess,
    needsConsent,
    wasLegalAcceptedThisProcess,
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
    const insets = useSafeAreaInsets();
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
    // wasLegalAcceptedThisProcess covers acceptance that happened OUTSIDE this
    // component before the session atom could reflect it: the pre-auth consent
    // step (device path) and the silent email-path stamp. Without it this gate
    // would re-prompt a user who agreed seconds ago on the auth screen.
    const shown =
        !isPending &&
        !accepted &&
        !wasLegalAcceptedThisProcess(userId) &&
        needsConsent(user, current);

    const handleAccept = useCallback(async () => {
        if (!current) return;
        setBusy(true);
        setError(false);
        const result = await acceptLegal(current);
        setBusy(false);
        if (result.ok) {
            setAccepted(true);
            // Mark the SHARED latch, not just the local one. `accepted` is
            // component state and the effect above resets it on any userId
            // change — including a transient null while the session atom
            // re-settles — so a remount of the logged-in layout would
            // re-derive "needed?" from a session that still reports the old
            // stamps and prompt a user who just accepted. This was the only
            // accept path in the app that did not mark it.
            if (userId) markLegalAcceptedThisProcess(userId);
        } else {
            setError(true);
        }
    }, [current, userId]);

    // An acceptance we KNOW happened but the server may not have recorded.
    //
    // The latch says this user consented in THIS process — the pre-auth
    // consent step marks it the moment device sign-in returns. If the session
    // nonetheless still reads as needing consent, the stamp did not land: a
    // failed versions fetch, a rejected POST, a device offline for those two
    // calls. Retry it silently. The user already agreed; re-asking them is not
    // a fix for a failed write, it IS the bug this gate was producing.
    //
    // Deliberately NOT derived from `shown`: the latch is one of `shown`'s
    // four ANDs, so `shown` is false for a latched user by construction and
    // the component returns null before rendering. Anything gated on it would
    // be dead code that ships as a silent no-op. The ref bounds it to one POST
    // per user, so a re-render cannot double-submit.
    const owedStampFor = useRef<string | null>(null);
    useEffect(() => {
        if (!userId || !current) return;
        if (!wasLegalAcceptedThisProcess(userId)) return;
        if (!needsConsent(user, current)) return;
        if (owedStampFor.current === userId) return;
        owedStampFor.current = userId;
        // Fire-and-forget on purpose: no spinner, no error surface, no effect
        // on what this gate shows. acceptLegal already reports its own
        // failures to Sentry.
        void acceptLegal(current);
    }, [userId, current, user]);

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
            testID="consent-screen"
            pointerEvents="auto"
            style={{
                position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100,
            }}
        >
            {/* OPAQUE BASE — the reason this is a page and not a popup, and it is
                load-bearing rather than decorative.

                AbstractGradientBackdrop is translucent EVERYWHERE and opaque
                NOWHERE: its own docs describe it as "an Svg with no background
                fill whose blobs peak at alpha 0.38". On the tab screens that is
                fine, because expo-router already paints an opaque navigation
                background underneath it. This gate is an absolute overlay ON TOP
                of a live logged-in tree, so there is no such background — without
                this fill the screen behind showed straight through the text and
                the gate read as a modal over another screen.

                Black specifically: the app is dark-mode only on a pure-black
                page, which is the ground the backdrop's alphas were tuned for. */}
            <View testID="consent-backdrop-fill" style={[StyleSheet.absoluteFill, { backgroundColor: '#000000' }]} />
            <AbstractGradientBackdrop />

            {/* The ScrollView is what keeps this a page at large Dynamic Type
                sizes — this copy is legally required to be readable, so it must
                never be clipped by a fixed-height box. */}
            <View
                className="flex-1 px-8"
                style={{ paddingTop: insets.top + 32, paddingBottom: insets.bottom + 24 }}
            >
                <ScrollView
                    contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
                    showsVerticalScrollIndicator={false}
                >
                    <ConsentContent
                        testIDPrefix="consent"
                        acceptTestID="consent-accept"
                        title={t('consent.title')}
                        body={t('consent.body')}
                        ctaLabel={error ? t('consent.retry') : t('consent.accept')}
                        busyLabel={t('consent.accepting')}
                        busy={busy}
                        disabled={!current}
                        onAccept={handleAccept}
                    >
                        {error ? (
                            <Text testID="consent-error" className="text-red-400 text-sm text-center">
                                {t('consent.errorDescription')}
                            </Text>
                        ) : null}
                    </ConsentContent>
                </ScrollView>
            </View>
        </View>
    );
}
