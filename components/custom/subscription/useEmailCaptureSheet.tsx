import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import validator from 'validator';

import { getSupportId } from '@/lib/support-id';
import {
    confirmEmailOtp,
    requestEmailOtp,
    type EmailCaptureErrorCode,
    type EmailCaptureOutcome,
    type EmailCaptureSource,
} from '@/lib/subscription/email-capture';

type Step = 'email' | 'otp' | 'done' | 'skip-confirm';

interface UseEmailCaptureSheetArgs {
    isOpen: boolean;
    onClose: () => void;
    source?: EmailCaptureSource;
    onOutcome?: (outcome: EmailCaptureOutcome) => void;
}

export function useEmailCaptureSheet({ isOpen, onClose, onOutcome }: UseEmailCaptureSheetArgs) {
    const { t } = useTranslation();
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

    // Same copy affordance as Settings: exact
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

    return {
        step,
        setStep,
        email,
        setEmail,
        otp,
        setOtp,
        busy,
        errorText,
        setErrorText,
        resendCooldown,
        supportId,
        copied,
        flushPendingOutcome,
        handleSheetClose,
        handleSkipConfirm,
        handleCopySupportId,
        handleSendCode,
        handleResend,
        handleConfirm,
    };
}
