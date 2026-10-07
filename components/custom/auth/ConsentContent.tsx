import React from 'react';
import { useTranslation } from 'react-i18next';

import { MaterialIcons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text as RNText, View } from 'react-native';

import { Button, ButtonSpinner, ButtonText } from '@/components/ui/button';
import { VStack } from '@/components/ui/vstack';
import { useColors } from '@/lib/theme/tokens';
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
    /** Shown IN PLACE OF the body, above the legal rows, so it is on screen
     *  BEFORE the commit tap. Only the pre-auth step passes one: the device
     *  sign-in notice (what signing in with this phone keeps), which is also
     *  the notice for reading the device ID. The re-consent gate never does,
     *  because it signs nobody in. */
    notice?: React.ReactNode;
    /** The "What Mera keeps" row (the device sign-in path only). */
    onWhatMeraKeeps?: () => void;
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
    notice,
    onWhatMeraKeeps,
    children,
}) => {
    const { t } = useTranslation();
    const colors = useColors();
    const blocked = busy || disabled;

    const Row = ({ label, icon, onPress, testID, role }: { label: string; icon: 'chevron-right' | 'open-in-new'; onPress: () => void; testID: string; role: 'button' | 'link' }) => (
        <Pressable
            testID={testID}
            accessible
            accessibilityRole={role}
            accessibilityLabel={label}
            onPress={onPress}
            style={[styles.row, { borderTopColor: colors.line }]}
        >
            <RNText style={[styles.rowLabel, { color: colors.ink }]}>{label}</RNText>
            <MaterialIcons name={icon} size={18} color={colors.ink3} />
        </Pressable>
    );

    return (
        <VStack testID={`${testIDPrefix}-cluster`} accessible={false} space="md">
            {/* One card on the backdrop (FinalJourney #7): title, what signing
                in keeps (or the body), then the legal destinations as rows. */}
            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
                <RNText accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
                    {title}
                </RNText>
                {notice ?? <RNText style={[styles.body, { color: colors.ink2 }]}>{body}</RNText>}
                <View style={styles.rows}>
                    {onWhatMeraKeeps ? (
                        <Row label={t('consent.whatMeraKeeps')} icon="chevron-right" onPress={onWhatMeraKeeps} testID={`${testIDPrefix}-what-mera-keeps`} role="link" />
                    ) : null}
                    <Row label={t('consent.termsLink')} icon="open-in-new" onPress={() => openInAppBrowser(withAppLanguage(TERMS_URL))} testID={`${testIDPrefix}-terms`} role="link" />
                    <Row label={t('consent.privacyLink')} icon="open-in-new" onPress={() => openInAppBrowser(withAppLanguage(PRIVACY_URL))} testID={`${testIDPrefix}-privacy`} role="link" />
                </View>
            </View>

            <Button
                action="primary"
                testID={acceptTestID ?? `${testIDPrefix}-agree`}
                onPress={onAccept}
                isDisabled={blocked}
                accessibilityLabel={busy && busyLabel ? busyLabel : ctaLabel}
                accessibilityState={blocked ? { busy, disabled: true } : undefined}
            >
                {busy ? <ButtonSpinner /> : null}
                <ButtonText>{busy && busyLabel ? busyLabel : ctaLabel}</ButtonText>
            </Button>

            {children}
        </VStack>
    );
};

const styles = StyleSheet.create({
    card: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, padding: 18, gap: 10 },
    title: { fontSize: 20, fontWeight: '700' },
    body: { fontSize: 15, lineHeight: 21 },
    rows: { marginTop: 4 },
    row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth },
    rowLabel: { fontSize: 15 },
});

export default ConsentContent;
