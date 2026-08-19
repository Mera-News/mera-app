/**
 * Email-at-purchase page: offer an anonymous (device sign-in) account a real
 * email for receipts and account recovery.
 *
 * Presented by EmailCaptureHost, which is mounted ONCE in
 * app/logged-in/_layout.tsx and listens to the registry in
 * lib/subscription/email-capture.ts — the purchase chokepoint
 * (refreshUserBillingAfterPurchase) and the checkout gate both raise the same
 * request rather than each owning a presentation.
 *
 * A full PAGE since 2026-08-19 (user call), not a dialog: a full-screen RN
 * Modal styled like the email/OTP login screens (TutorialModalHost's recipe —
 * overFullScreen + transparent, own dark GluestackUIProvider; NOT a route, so
 * the promise-based checkout gate and the single host mount stay untouched).
 *
 * Exits and outcomes:
 *  - verify (email → OTP → done)            → 'verified'  (checkout proceeds)
 *  - "Continue without email" → consequence
 *    step → "Continue to payment"           → 'skipped'   (checkout proceeds)
 *  - "Not now" / Android hardware back      → 'dismissed' (checkout aborts)
 * The skip confirm has its OWN handler on purpose: the shared close funnel
 * also serves hardware back, which must never silently become a skip.
 *
 * The OTP step mirrors OTPVerificationView's resend idiom (30s cooldown)
 * rather than inventing a second pattern.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import validator from 'validator';

import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import MeraLogo from '@/components/custom/MeraLogo';
import { Box } from '@/components/ui/box';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { HStack } from '@/components/ui/hstack';
import { Input, InputField } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { ScrollView } from '@/components/ui/scroll-view';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { getSupportId } from '@/lib/support-id';
import {
    completeEmailCapture,
    confirmEmailOtp,
    requestEmailOtp,
    subscribeEmailCapture,
    type EmailCaptureErrorCode,
    type EmailCaptureOutcome,
    type EmailCaptureSource,
} from '@/lib/subscription/email-capture';
import { MaterialIcons } from '@expo/vector-icons';

type Step = 'email' | 'otp' | 'done' | 'skip-confirm';

interface EmailCaptureSheetProps {
    isOpen: boolean;
    onClose: () => void;
    /** Where the request came from. The informed-skip path renders ONLY for
     *  'checkout' — the post-purchase presentation has no checkout to proceed
     *  to, so its only exits stay verify / Not now. */
    source?: EmailCaptureSource;
    /** Reported on EVERY close: 'verified' when the flow reached done,
     *  'skipped' via the consequence step's confirm, 'dismissed' otherwise.
     *  The S10 checkout gate keys on it; the post-purchase presentation
     *  ignores it. */
    onOutcome?: (outcome: EmailCaptureOutcome) => void;
}

export function EmailCaptureSheet({ isOpen, onClose, source, onOutcome }: EmailCaptureSheetProps) {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const [step, setStep] = useState<Step>('email');
    const [email, setEmail] = useState('');
    const [otp, setOtp] = useState('');
    const [busy, setBusy] = useState(false);
    const [errorText, setErrorText] = useState('');
    const [resendCooldown, setResendCooldown] = useState(0);
    const [supportId, setSupportId] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Reset per presentation, not on close — closing mid-step must not flash
    // the reset state while the modal animates out. The Support ID loads here
    // too so the consequence step never opens onto an empty pill.
    useEffect(() => {
        if (!isOpen) return;
        setStep('email');
        setEmail('');
        setOtp('');
        setBusy(false);
        setErrorText('');
        setResendCooldown(0);
        setCopied(false);
        let cancelled = false;
        getSupportId().then((id) => {
            if (!cancelled) setSupportId(id);
        });
        return () => {
            cancelled = true;
        };
    }, [isOpen]);

    useEffect(
        () => () => {
            if (copyTimer.current) clearTimeout(copyTimer.current);
        },
        [],
    );

    useEffect(() => {
        if (resendCooldown <= 0) return;
        const timer = setInterval(() => setResendCooldown((s) => s - 1), 1000);
        return () => clearInterval(timer);
    }, [resendCooldown]);

    // ── OUTCOME IS DEFERRED UNTIL THE MODAL HAS ACTUALLY DISMISSED ─────────
    //
    // e2e-proven bug (2026-08-19): reporting the outcome synchronously with
    // onClose() let the checkout gate resolve while this full-screen Modal was
    // still animating out — RevenueCat then presented its paywall on THIS
    // modal's dying view controller and UIKit silently dropped it ("whose view
    // is not in the window hierarchy"), turning "Continue to payment" into a
    // dead end. Same trap class LanguageSelector documents for the iOS
    // language sheet; same cure: flush on the Modal's onDismiss, which fires
    // only after the dismissal transition finishes. onDismiss is iOS-only, so
    // Android (where RevenueCat presents on the activity, not the dying modal
    // host) flushes as soon as `isOpen` flips false, and an unmount flush
    // backstops both so an armed gate can never dangle.
    const pendingOutcome = useRef<EmailCaptureOutcome | null>(null);
    const onOutcomeRef = useRef(onOutcome);
    useEffect(() => {
        onOutcomeRef.current = onOutcome;
    });

    const flushPendingOutcome = useCallback(() => {
        const outcome = pendingOutcome.current;
        pendingOutcome.current = null;
        if (outcome) onOutcomeRef.current?.(outcome);
    }, []);

    const closeWith = useCallback(
        (outcome: EmailCaptureOutcome) => {
            pendingOutcome.current = outcome;
            onClose();
        },
        [onClose],
    );

    useEffect(() => {
        if (!isOpen && Platform.OS !== 'ios') flushPendingOutcome();
    }, [flushPendingOutcome, isOpen]);
    useEffect(() => () => flushPendingOutcome(), [flushPendingOutcome]);

    // Every ORDINARY exit funnels through here so the outcome can never be
    // skipped — including Android's hardware back (onRequestClose). The
    // informed skip deliberately does NOT use this funnel.
    const handleSheetClose = useCallback(() => {
        closeWith(step === 'done' ? 'verified' : 'dismissed');
    }, [closeWith, step]);

    // The ONE way a 'skipped' outcome can be produced: the consequence step's
    // explicit confirm.
    const handleSkipConfirm = useCallback(() => {
        closeWith('skipped');
    }, [closeWith]);

    // Same copy affordance as Settings and the welcome-back screen: exact
    // string, transient "Copied" swap, no toast.
    const handleCopySupportId = useCallback(async () => {
        if (!supportId) return;
        try {
            await Clipboard.setStringAsync(supportId);
        } catch {
            // Clipboard unavailable — no feedback state, nothing to undo.
            return;
        }
        setCopied(true);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 1800);
    }, [supportId]);

    const errorFor = useCallback(
        (code: EmailCaptureErrorCode): string => {
            if (code === 'invalid-email') return t('auth.invalidEmailDescription');
            if (code === 'invalid-otp') return t('auth.invalidOtpServer');
            return t('common.tryAgain');
        },
        [t],
    );

    const handleSendCode = async () => {
        if (busy) return;
        if (!email || !validator.isEmail(email)) {
            setErrorText(t('auth.invalidEmailDescription'));
            return;
        }
        setBusy(true);
        setErrorText('');
        const result = await requestEmailOtp(email.trim());
        setBusy(false);
        if (result.ok) {
            setStep('otp');
            setOtp('');
            setResendCooldown(30);
        } else {
            setErrorText(errorFor(result.errorCode));
        }
    };

    const handleResend = async () => {
        if (busy || resendCooldown > 0) return;
        setBusy(true);
        setErrorText('');
        const result = await requestEmailOtp(email.trim());
        setBusy(false);
        if (result.ok) {
            // The server hashes OTPs at rest: a resend ALWAYS issues a fresh
            // code and invalidates the previous one, which is why the input is
            // cleared here rather than left for a re-submit.
            setOtp('');
            setResendCooldown(30);
        } else {
            setErrorText(errorFor(result.errorCode));
        }
    };

    const handleConfirm = async () => {
        if (busy) return;
        if (!otp || otp.length < 6) {
            setErrorText(t('auth.invalidOtp'));
            return;
        }
        setBusy(true);
        setErrorText('');
        const result = await confirmEmailOtp(email.trim(), otp);
        setBusy(false);
        if (result.ok) {
            setStep('done');
        } else {
            setErrorText(errorFor(result.errorCode));
        }
    };

    return (
        <Modal
            visible={isOpen}
            animationType="slide"
            presentationStyle="overFullScreen"
            transparent
            statusBarTranslucent
            onRequestClose={handleSheetClose}
            onDismiss={flushPendingOutcome}
        >
            <GluestackUIProvider mode="dark">
                {/* OPAQUE BASE, load-bearing: AbstractGradientBackdrop is
                    translucent everywhere (alpha-only blobs), and this modal
                    floats over a live logged-in tree — without the fill the
                    screen behind shows straight through the copy. Same note as
                    ConsentGate. */}
                <View
                    testID="email-capture-backdrop-fill"
                    style={[StyleSheet.absoluteFill, { backgroundColor: '#000000' }]}
                />
                <AbstractGradientBackdrop />

                <Box
                    testID="email-capture-sheet"
                    accessible={false}
                    className="flex-1 px-6"
                    style={{ paddingTop: insets.top + 32, paddingBottom: insets.bottom + 24 }}
                >
                    <ScrollView
                        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
                        keyboardShouldPersistTaps="handled"
                        showsVerticalScrollIndicator={false}
                    >
                        <Box accessible={false} className="items-center mb-8">
                            <MeraLogo size={96} />
                        </Box>

                        {step === 'email' && (
                            <VStack accessible={false} space="md">
                                <Text size="2xl" className="text-white font-semibold text-center">
                                    {t('emailCapture.title')}
                                </Text>
                                <Text size="md" className="text-gray-300 text-center">
                                    {t('emailCapture.subtitle')}
                                </Text>
                                <Input size="lg" className="mt-2">
                                    <InputField
                                        testID="email-capture-email-input"
                                        placeholder={t('auth.emailPlaceholder')}
                                        value={email}
                                        onChangeText={(text) => {
                                            setEmail(text);
                                            setErrorText('');
                                        }}
                                        keyboardType="email-address"
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                    />
                                </Input>
                                {errorText ? (
                                    <Text size="sm" className="text-error-500 text-center">
                                        {errorText}
                                    </Text>
                                ) : null}
                                <Pressable
                                    testID="email-capture-continue"
                                    onPress={handleSendCode}
                                    disabled={busy}
                                    accessible
                                    accessibilityRole="button"
                                    accessibilityLabel={t('emailCapture.continue')}
                                    className={`h-14 rounded-full items-center justify-center ${busy ? 'bg-gray-700' : 'bg-primary-500'}`}
                                >
                                    {busy ? (
                                        <Spinner size="small" color="black" />
                                    ) : (
                                        <Text className="text-black text-base font-semibold">
                                            {t('emailCapture.continue')}
                                        </Text>
                                    )}
                                </Pressable>
                                {source === 'checkout' && (
                                    <Pressable
                                        testID="email-capture-skip"
                                        onPress={() => {
                                            setErrorText('');
                                            setStep('skip-confirm');
                                        }}
                                        accessible
                                        accessibilityRole="button"
                                        accessibilityLabel={t('emailCapture.skip')}
                                        className="h-14 rounded-full items-center justify-center border border-primary-500 bg-transparent"
                                    >
                                        <Text className="text-primary-500 text-base font-semibold">
                                            {t('emailCapture.skip')}
                                        </Text>
                                    </Pressable>
                                )}
                                <Pressable
                                    testID="email-capture-not-now"
                                    onPress={handleSheetClose}
                                    accessible
                                    accessibilityRole="button"
                                    accessibilityLabel={t('emailCapture.notNow')}
                                    className="py-2 items-center"
                                >
                                    <Text size="sm" className="text-gray-400">
                                        {t('emailCapture.notNow')}
                                    </Text>
                                </Pressable>
                            </VStack>
                        )}

                        {step === 'otp' && (
                            <VStack accessible={false} space="md">
                                <Text size="2xl" className="text-white font-semibold text-center">
                                    {t('emailCapture.title')}
                                </Text>
                                <Text size="md" className="text-gray-300 text-center">
                                    {t('auth.sentTo')}{' '}
                                    <Text size="md" className="text-gray-300 font-bold">
                                        {email.trim()}
                                    </Text>
                                </Text>
                                <Input size="lg" className="mt-2">
                                    <InputField
                                        testID="email-capture-otp-input"
                                        placeholder={t('auth.otpPlaceholder')}
                                        value={otp}
                                        onChangeText={(text) => {
                                            setOtp(text);
                                            setErrorText('');
                                        }}
                                        keyboardType="number-pad"
                                        maxLength={6}
                                        autoCapitalize="none"
                                    />
                                </Input>
                                {errorText ? (
                                    <Text size="sm" className="text-error-500 text-center">
                                        {errorText}
                                    </Text>
                                ) : null}
                                <Box accessible={false} className="items-center">
                                    {resendCooldown > 0 ? (
                                        <Text size="sm" className="text-typography-500">
                                            {t('auth.resendIn', { seconds: resendCooldown })}
                                        </Text>
                                    ) : (
                                        <Pressable
                                            testID="email-capture-resend"
                                            onPress={handleResend}
                                            disabled={busy}
                                            accessible
                                            accessibilityRole="button"
                                            accessibilityLabel={t('auth.resendCode')}
                                        >
                                            <Text size="sm" className="text-primary-400">
                                                {t('auth.resendCode')}
                                            </Text>
                                        </Pressable>
                                    )}
                                </Box>
                                <Pressable
                                    testID="email-capture-confirm"
                                    onPress={handleConfirm}
                                    disabled={busy || otp.length < 6}
                                    accessible
                                    accessibilityRole="button"
                                    accessibilityLabel={t('emailCapture.confirm')}
                                    className={`h-14 rounded-full items-center justify-center ${otp.length === 6 && !busy ? 'bg-primary-500' : 'bg-gray-700'}`}
                                >
                                    {busy ? (
                                        <Spinner size="small" color="black" />
                                    ) : (
                                        <Text className="text-black text-base font-semibold">
                                            {t('emailCapture.confirm')}
                                        </Text>
                                    )}
                                </Pressable>
                                <Pressable
                                    testID="email-capture-back"
                                    onPress={() => {
                                        setStep('email');
                                        setErrorText('');
                                    }}
                                    accessible
                                    accessibilityRole="button"
                                    accessibilityLabel={t('common.back')}
                                    className="py-2 items-center"
                                >
                                    <Text size="sm" className="text-gray-400">
                                        {t('common.back')}
                                    </Text>
                                </Pressable>
                            </VStack>
                        )}

                        {step === 'skip-confirm' && (
                            <VStack accessible={false} space="md">
                                <Text size="2xl" className="text-white font-semibold text-center">
                                    {t('emailCapture.skipTitle')}
                                </Text>
                                <Text size="md" className="text-gray-300 text-center">
                                    {t('emailCapture.skipBody1')}
                                </Text>
                                <Text size="md" className="text-gray-300 text-center">
                                    {t('emailCapture.skipBody2')}
                                </Text>

                                {supportId && (
                                    <VStack accessible={false} space="xs" className="items-center mt-2">
                                        <HStack
                                            accessible={false}
                                            space="md"
                                            className="items-center border border-gray-700 rounded-full px-5 py-2.5"
                                        >
                                            <Text
                                                size="md"
                                                className="text-white font-semibold"
                                                testID="email-capture-support-id"
                                            >
                                                {t('support.supportId', { id: supportId })}
                                            </Text>
                                            <Pressable
                                                testID="email-capture-copy-support-id"
                                                onPress={handleCopySupportId}
                                                hitSlop={8}
                                                accessible
                                                accessibilityRole="button"
                                                accessibilityLabel={
                                                    copied ? t('support.copied') : t('support.copySupportId')
                                                }
                                            >
                                                {copied ? (
                                                    <Text size="sm" className="text-primary-400">
                                                        {t('support.copied')}
                                                    </Text>
                                                ) : (
                                                    <MaterialIcons name="content-copy" size={18} color="#9ca3af" />
                                                )}
                                            </Pressable>
                                        </HStack>
                                        <Text size="xs" className="text-gray-500 text-center">
                                            {t('support.saveHint')}
                                        </Text>
                                    </VStack>
                                )}

                                <Pressable
                                    testID="email-capture-skip-confirm"
                                    onPress={handleSkipConfirm}
                                    accessible
                                    accessibilityRole="button"
                                    accessibilityLabel={t('emailCapture.skipConfirm')}
                                    className="h-14 rounded-full items-center justify-center bg-primary-500 mt-2"
                                >
                                    <Text className="text-black text-base font-semibold">
                                        {t('emailCapture.skipConfirm')}
                                    </Text>
                                </Pressable>
                                <Pressable
                                    testID="email-capture-skip-back"
                                    onPress={() => setStep('email')}
                                    accessible
                                    accessibilityRole="button"
                                    accessibilityLabel={t('common.back')}
                                    className="py-2 items-center"
                                >
                                    <Text size="sm" className="text-gray-400">
                                        {t('common.back')}
                                    </Text>
                                </Pressable>
                            </VStack>
                        )}

                        {step === 'done' && (
                            <VStack accessible={false} space="md">
                                <Text size="2xl" className="text-white font-semibold text-center">
                                    {t('emailCapture.added')}
                                </Text>
                                <Text size="md" className="text-gray-300 text-center">
                                    {t('emailCapture.addedDetail', { email: email.trim() })}
                                </Text>
                                <Pressable
                                    testID="email-capture-done"
                                    onPress={handleSheetClose}
                                    accessible
                                    accessibilityRole="button"
                                    accessibilityLabel={t('common.done')}
                                    className="h-14 rounded-full items-center justify-center bg-primary-500 mt-2"
                                >
                                    <Text className="text-black text-base font-semibold">
                                        {t('common.done')}
                                    </Text>
                                </Pressable>
                            </VStack>
                        )}
                    </ScrollView>
                </Box>
            </GluestackUIProvider>
        </Modal>
    );
}

/**
 * Mounted once for the whole logged-in tree (app/logged-in/_layout.tsx).
 * Renders nothing until a capture request arrives from the registry; the
 * request's source is threaded through so the page knows whether it is the
 * checkout gate (skip path available) or the post-purchase offer.
 */
export default function EmailCaptureHost() {
    const [isOpen, setIsOpen] = useState(false);
    const [source, setSource] = useState<EmailCaptureSource>('purchase');

    useEffect(() => {
        return subscribeEmailCapture((requestSource) => {
            setSource(requestSource);
            setIsOpen(true);
        });
    }, []);

    const handleClose = useCallback(() => setIsOpen(false), []);

    return (
        <EmailCaptureSheet
            isOpen={isOpen}
            onClose={handleClose}
            source={source}
            onOutcome={completeEmailCapture}
        />
    );
}
