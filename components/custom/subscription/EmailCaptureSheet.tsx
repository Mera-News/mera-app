/**
 * Email-at-purchase sheet: offer an anonymous (device sign-in) account a real
 * email for receipts and account recovery.
 *
 * Presented by EmailCaptureHost, which is mounted ONCE in
 * app/logged-in/_layout.tsx and listens to the registry in
 * lib/subscription/email-capture.ts — the purchase chokepoint
 * (refreshUserBillingAfterPurchase) and the Settings row both raise the same
 * request rather than each owning a modal.
 *
 * Always skippable ("Not now"): the account works without an email; this is an
 * offer, not a gate. The OTP step mirrors OTPVerificationView's resend idiom
 * (30s cooldown) rather than inventing a second pattern.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import validator from 'validator';

import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Input, InputField } from '@/components/ui/input';
import {
    Modal,
    ModalBackdrop,
    ModalBody,
    ModalContent,
    ModalFooter,
    ModalHeader,
} from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import {
    completeEmailCapture,
    confirmEmailOtp,
    requestEmailOtp,
    subscribeEmailCapture,
    type EmailCaptureErrorCode,
} from '@/lib/subscription/email-capture';

type Step = 'email' | 'otp' | 'done';

interface EmailCaptureSheetProps {
    isOpen: boolean;
    onClose: () => void;
    /** Reported on EVERY close: 'verified' when the flow reached done,
     *  'dismissed' otherwise. The S10 checkout gate keys on it; the settings
     *  and post-purchase presentations ignore it. */
    onOutcome?: (outcome: 'verified' | 'dismissed') => void;
}

export function EmailCaptureSheet({ isOpen, onClose, onOutcome }: EmailCaptureSheetProps) {
    const { t } = useTranslation();
    const [step, setStep] = useState<Step>('email');
    const [email, setEmail] = useState('');
    const [otp, setOtp] = useState('');
    const [busy, setBusy] = useState(false);
    const [errorText, setErrorText] = useState('');
    const [resendCooldown, setResendCooldown] = useState(0);

    // Reset per presentation, not on close — closing mid-step must not flash
    // the reset state while the modal animates out.
    useEffect(() => {
        if (isOpen) {
            setStep('email');
            setEmail('');
            setOtp('');
            setBusy(false);
            setErrorText('');
            setResendCooldown(0);
        }
    }, [isOpen]);

    useEffect(() => {
        if (resendCooldown <= 0) return;
        const timer = setInterval(() => setResendCooldown((s) => s - 1), 1000);
        return () => clearInterval(timer);
    }, [resendCooldown]);

    // Every exit funnels through here so the outcome can never be skipped —
    // including the Modal's own backdrop/back-button close.
    const handleSheetClose = useCallback(() => {
        onOutcome?.(step === 'done' ? 'verified' : 'dismissed');
        onClose();
    }, [onClose, onOutcome, step]);

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
        <Modal isOpen={isOpen} onClose={handleSheetClose} size="md">
            <ModalBackdrop />
            <ModalContent testID="email-capture-sheet">
                {step === 'email' && (
                    <>
                        <ModalHeader className="border-gray-700 pb-2">
                            <Text className="text-xl font-semibold text-white">
                                {t('emailCapture.title')}
                            </Text>
                        </ModalHeader>
                        <ModalBody className="py-4">
                            <Text className="text-gray-300 text-base mb-4">
                                {t('emailCapture.subtitle')}
                            </Text>
                            <Input size="lg">
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
                                <Text size="sm" className="text-error-500 mt-2">
                                    {errorText}
                                </Text>
                            ) : null}
                        </ModalBody>
                        <ModalFooter className="pt-2">
                            <HStack space="md" className="items-center justify-end w-full">
                                <Pressable
                                    testID="email-capture-not-now"
                                    onPress={handleSheetClose}
                                    className="px-4 py-2"
                                >
                                    <Text className="text-gray-400 text-base">
                                        {t('emailCapture.notNow')}
                                    </Text>
                                </Pressable>
                                <Pressable
                                    testID="email-capture-continue"
                                    onPress={handleSendCode}
                                    disabled={busy}
                                    className="bg-primary-500 rounded-lg px-5 py-2 items-center justify-center"
                                >
                                    {busy ? (
                                        <Spinner size="small" color="black" />
                                    ) : (
                                        <Text className="text-black text-base font-semibold">
                                            {t('emailCapture.continue')}
                                        </Text>
                                    )}
                                </Pressable>
                            </HStack>
                        </ModalFooter>
                    </>
                )}

                {step === 'otp' && (
                    <>
                        <ModalHeader className="border-gray-700 pb-2">
                            <Text className="text-xl font-semibold text-white">
                                {t('emailCapture.title')}
                            </Text>
                        </ModalHeader>
                        <ModalBody className="py-4">
                            <Text className="text-gray-300 text-base mb-4">
                                {t('auth.sentTo')}{' '}
                                <Text className="text-gray-300 text-base font-bold">
                                    {email.trim()}
                                </Text>
                            </Text>
                            <Input size="lg">
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
                                <Text size="sm" className="text-error-500 mt-2">
                                    {errorText}
                                </Text>
                            ) : null}
                            <Box className="mt-3 items-start">
                                {resendCooldown > 0 ? (
                                    <Text size="sm" className="text-typography-500">
                                        {t('auth.resendIn', { seconds: resendCooldown })}
                                    </Text>
                                ) : (
                                    <Pressable
                                        testID="email-capture-resend"
                                        onPress={handleResend}
                                        disabled={busy}
                                    >
                                        <Text size="sm" className="text-primary-400">
                                            {t('auth.resendCode')}
                                        </Text>
                                    </Pressable>
                                )}
                            </Box>
                        </ModalBody>
                        <ModalFooter className="pt-2">
                            <HStack space="md" className="items-center justify-end w-full">
                                <Pressable
                                    testID="email-capture-back"
                                    onPress={() => {
                                        setStep('email');
                                        setErrorText('');
                                    }}
                                    className="px-4 py-2"
                                >
                                    <Text className="text-gray-400 text-base">
                                        {t('common.back')}
                                    </Text>
                                </Pressable>
                                <Pressable
                                    testID="email-capture-confirm"
                                    onPress={handleConfirm}
                                    disabled={busy || otp.length < 6}
                                    className={`rounded-lg px-5 py-2 items-center justify-center ${otp.length === 6 && !busy ? 'bg-primary-500' : 'bg-gray-700'}`}
                                >
                                    {busy ? (
                                        <Spinner size="small" color="black" />
                                    ) : (
                                        <Text className="text-black text-base font-semibold">
                                            {t('emailCapture.confirm')}
                                        </Text>
                                    )}
                                </Pressable>
                            </HStack>
                        </ModalFooter>
                    </>
                )}

                {step === 'done' && (
                    <>
                        <ModalHeader className="border-gray-700 pb-2">
                            <Text className="text-xl font-semibold text-white">
                                {t('emailCapture.added')}
                            </Text>
                        </ModalHeader>
                        <ModalBody className="py-4">
                            <Text className="text-gray-300 text-base">
                                {t('emailCapture.addedDetail', { email: email.trim() })}
                            </Text>
                        </ModalBody>
                        <ModalFooter className="pt-2">
                            <Pressable
                                testID="email-capture-done"
                                onPress={handleSheetClose}
                                className="bg-primary-500 rounded-lg px-5 py-2 items-center justify-center"
                            >
                                <Text className="text-black text-base font-semibold">
                                    {t('common.done')}
                                </Text>
                            </Pressable>
                        </ModalFooter>
                    </>
                )}
            </ModalContent>
        </Modal>
    );
}

/**
 * Mounted once for the whole logged-in tree (app/logged-in/_layout.tsx).
 * Renders nothing until a capture request arrives from the registry.
 */
export default function EmailCaptureHost() {
    const [isOpen, setIsOpen] = useState(false);

    useEffect(() => {
        return subscribeEmailCapture(() => setIsOpen(true));
    }, []);

    const handleClose = useCallback(() => setIsOpen(false), []);

    return (
        <EmailCaptureSheet
            isOpen={isOpen}
            onClose={handleClose}
            onOutcome={completeEmailCapture}
        />
    );
}
