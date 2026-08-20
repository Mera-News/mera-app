import React from 'react';
import { useTranslation } from 'react-i18next';

import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { PRIVACY_URL, TERMS_URL } from '@/lib/config/branding';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';

interface ConsentContentProps {
    /** Heading. Each host supplies its OWN copy pair — the pre-auth step uses
     *  `consent.welcomeTitle`/`welcomeBody` ("Welcome to Mera"), the re-consent
     *  gate uses `consent.title`/`consent.body` ("we've updated our terms").
     *  Do not collapse them into one pair here: a version-bump re-consent that
     *  greets an existing user with "Welcome to Mera" is the bug that
     *  separation prevents. */
    title: string;
    body: string;
    /** Primary commit label in its idle state. */
    ctaLabel: string;
    /** Replaces `ctaLabel` while the accept is in flight. */
    busyLabel?: string;
    busy?: boolean;
    disabled?: boolean;
    onAccept: () => void;
    /** Prefix for the three interactive testIDs (`-terms`, `-privacy`,
     *  `-agree`). Each host keeps the ids QA and the harness already key off. */
    testIDPrefix: string;
    /** Overrides `${testIDPrefix}-agree` on the commit button. The gate keeps
     *  `consent-accept`, which harness/README-android.md documents as a
     *  driving target. */
    acceptTestID?: string;
    /** Host-specific extras rendered below the CTA: the device sign-in failure
     *  cluster on the pre-auth step, the save-failed line on the gate. */
    children?: React.ReactNode;
}

/**
 * The consent surface itself: heading, body, the two legal destinations and
 * the commit action. Presentational only — it owns no state, performs no
 * network call and decides nothing about whether consent is needed.
 *
 * Extracted because there are TWO hosts and they had drifted. The pre-auth
 * consent step and the re-consent gate were separately hand-maintained
 * layouts, so restyling Terms/Privacy into half-and-half outline buttons on
 * the step left the gate on underlined text links — two screens the same user
 * can meet minutes apart, wearing different affordances for the same choice.
 *
 * Deliberately imports NO backdrop, logo or footer. Those stay in the hosts:
 * anything here that reaches MeraLogo or AbstractGradientBackdrop drags
 * reanimated into every suite that renders a host, and the onboarding/paywall
 * suites fail at IMPORT with "Native part of Worklets doesn't seem to be
 * initialized".
 */
const ConsentContent: React.FC<ConsentContentProps> = ({
    title,
    body,
    ctaLabel,
    busyLabel,
    busy = false,
    disabled = false,
    onAccept,
    testIDPrefix,
    acceptTestID,
    children,
}) => {
    // Both hosts label the legal destinations with the SAME two keys; only
    // the heading/body pair differs, which is why those are props and these
    // are not.
    const { t } = useTranslation();
    const termsLabel = t('consent.termsLink');
    const privacyLabel = t('consent.privacyLink');
    const blocked = busy || disabled;

    return (
        <VStack testID={`${testIDPrefix}-cluster`} accessible={false} space="md">
            <VStack accessible={false} space="sm">
                <Text size="2xl" className="text-white font-semibold text-center">
                    {title}
                </Text>
                <Text size="md" className="text-gray-300 text-center">
                    {body}
                </Text>
            </VStack>

            {/* Two outline buttons, half and half — the same primary outline the
                welcome view's secondary actions wear, so the legal links read as
                real destinations rather than fine print. `py-3` instead of a
                fixed height: several locales run long here and must wrap without
                clipping. Real padding, no hitSlop — overlapping slops resolve by
                z-order and a tap in the gap would silently open the LATER
                button. */}
            <HStack accessible={false} space="md" className="items-stretch">
                <Pressable
                    testID={`${testIDPrefix}-terms`}
                    accessible
                    accessibilityRole="link"
                    accessibilityLabel={termsLabel}
                    onPress={() => openInAppBrowser(withAppLanguage(TERMS_URL))}
                    className="flex-1 rounded-full border border-primary-500 bg-transparent items-center justify-center py-3 px-3"
                >
                    <Text size="sm" className="text-primary-500 font-semibold text-center">
                        {termsLabel}
                    </Text>
                </Pressable>
                <Pressable
                    testID={`${testIDPrefix}-privacy`}
                    accessible
                    accessibilityRole="link"
                    accessibilityLabel={privacyLabel}
                    onPress={() => openInAppBrowser(withAppLanguage(PRIVACY_URL))}
                    className="flex-1 rounded-full border border-primary-500 bg-transparent items-center justify-center py-3 px-3"
                >
                    <Text size="sm" className="text-primary-500 font-semibold text-center">
                        {privacyLabel}
                    </Text>
                </Pressable>
            </HStack>

            <Pressable
                testID={acceptTestID ?? `${testIDPrefix}-agree`}
                onPress={onAccept}
                disabled={blocked}
                accessible
                accessibilityRole="button"
                accessibilityLabel={busy && busyLabel ? busyLabel : ctaLabel}
                accessibilityState={blocked ? { busy, disabled: true } : undefined}
                className={`h-14 rounded-full items-center justify-center ${blocked ? 'bg-gray-700' : 'bg-primary-500'}`}
            >
                {busy ? (
                    <HStack space="sm" className="items-center">
                        <Spinner size="small" color="white" />
                        <Text className="text-white text-base font-semibold">
                            {busyLabel ?? ctaLabel}
                        </Text>
                    </HStack>
                ) : (
                    <Text className="text-black text-base font-semibold">{ctaLabel}</Text>
                )}
            </Pressable>

            {children}
        </VStack>
    );
};

export default ConsentContent;
