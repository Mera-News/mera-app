import React from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button, ButtonSpinner, ButtonText } from '@/components/ui/button';
import { Modal, ModalBackdrop, ModalBody, ModalContent } from '@/components/ui/modal';
import { Text } from '@/components/ui/text';
import { settleDialog, useDialogQueue } from '@/lib/dialog';
import { useColors } from '@/lib/theme/tokens';

/** 44pt, as the Modals board; the size tiers render short in this app. */
const BUTTON = { height: 44 } as const;

export interface ConfirmDialogProps {
    open: boolean;
    title: string;
    body?: string;
    /** A consequence line under the body, in the warning red (Modals #2). */
    warning?: string;
    confirmLabel: string;
    onConfirm: () => void;
    /** Cancel, a scrim tap or hardware back. The parent closes the dialog.
     *  Omit it for a one-button notice (OK, Got it): the scrim and Back then
     *  call onConfirm. */
    onCancel?: () => void;
    cancelLabel?: string;
    /** A destructive confirm is red; otherwise it is the primary orange. */
    destructive?: boolean;
    /** The action is running: a spinner on the confirm, both buttons off. */
    busy?: boolean;
    testID?: string;
}

/**
 * The ONE dialog (Modals board "A choice"): a centred dialog on the modal
 * material, title, body, an optional red consequence line, then the confirm
 * over an outlined Cancel, or one button for a notice. The app draws no
 * native alerts (owner rule); from plain code use
 * `showDialog` (lib/dialog.ts), which `DialogHost` below renders.
 */
export function ConfirmDialog({
    open,
    title,
    body,
    warning,
    confirmLabel,
    onConfirm,
    onCancel,
    cancelLabel,
    destructive,
    busy,
    testID,
}: ConfirmDialogProps) {
    const { t } = useTranslation();
    const colors = useColors();
    return (
        <Modal isOpen={open} onClose={busy ? undefined : (onCancel ?? onConfirm)} size="md">
            <ModalBackdrop />
            <ModalContent testID={testID}>
                <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 20, fontWeight: '700' }}>
                    {title}
                </Text>
                <ModalBody>
                    {body ? <Text style={{ color: colors.ink2, fontSize: 16, lineHeight: 22 }}>{body}</Text> : null}
                    {warning ? (
                        <Text style={{ color: colors.negative, fontSize: 14, lineHeight: 20, marginTop: 8 }}>
                            {warning}
                        </Text>
                    ) : null}
                </ModalBody>
                <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 16 }}>
                    <Button
                        action={destructive ? 'negative' : 'primary'}
                        onPress={onConfirm}
                        isDisabled={busy}
                        style={BUTTON}
                        testID={testID ? `${testID}-confirm` : undefined}
                    >
                        {busy ? <ButtonSpinner /> : null}
                        <ButtonText>{confirmLabel}</ButtonText>
                    </Button>
                    {onCancel ? (
                        <Button
                            variant="outline"
                            action="secondary"
                            onPress={onCancel}
                            isDisabled={busy}
                            style={BUTTON}
                            testID={testID ? `${testID}-cancel` : undefined}
                        >
                            <ButtonText>{cancelLabel ?? t('common.cancel')}</ButtonText>
                        </Button>
                    ) : null}
                </View>
            </ModalContent>
        </Modal>
    );
}

/** Renders `showDialog` requests, one at a time. Mounted once in app/_layout.tsx. */
export function DialogHost() {
    const front = useDialogQueue((s) => s.queue[0]);
    if (!front) return null;
    return (
        <ConfirmDialog
            key={front.id}
            open
            title={front.title}
            body={front.body}
            warning={front.warning}
            confirmLabel={front.confirmLabel}
            cancelLabel={front.cancelLabel}
            destructive={front.destructive}
            onConfirm={() => settleDialog(front.id, true)}
            onCancel={front.cancelLabel === undefined ? undefined : () => settleDialog(front.id, false)}
            testID="app-dialog"
        />
    );
}
