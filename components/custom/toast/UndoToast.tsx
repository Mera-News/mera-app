import { Toast, TOAST_ACCENT } from '@/components/ui/toast';
import React from 'react';
import { Pressable, Text } from 'react-native';
import { TOAST_BODY_COLOR, TOAST_TITLE_COLOR } from './toast-text';

/**
 * THE UNDO TOAST: the one look for every "done, with Undo" confirmation (the
 * feedback leaf's "Got it: feed updated", the ••• menu's "Fewer from <source>").
 * Success style: the green check card, with the Undo in the success accent,
 * bold and underlined, so it reads as the control it is rather than a third line
 * of prose. Show it through `toastManager.showUndoToast`, never hand-built: two
 * undo toasts that look different read as two different kinds of event.
 *
 * VERIFIED ON DEVICE, and the shape matters more than it looks:
 *   - FLAT children of `Toast`. Wrapping them in an HStack/VStack row rendered
 *     as an EMPTY pill.
 *   - Plain RN `Text` with explicit styles, not `ToastTitle` / `ToastDescription`
 *     (see `toast-text.ts`).
 * Do not "tidy" either back without checking on a device; jest cannot see it.
 */

/** The Undo control's minimum frame, each way. The WHOLE frame is the target:
 *  a device run found taps on the bare text doing nothing. */
export const UNDO_TARGET_PT = 44;

export interface UndoToastProps {
    title: string;
    body?: string;
    undoLabel: string;
    /** Required: a reusable primitive carries no default testID. */
    undoTestID: string;
    onUndo: () => void;
}

export default function UndoToast({ title, body, undoLabel, undoTestID, onUndo }: UndoToastProps) {
    return (
        <Toast action="success" variant="solid">
            <Text style={{ color: TOAST_TITLE_COLOR, fontWeight: '700', fontSize: 15 }}>{title}</Text>
            {body ? (
                <Text style={{ color: TOAST_BODY_COLOR, fontSize: 13, paddingTop: 2 }}>{body}</Text>
            ) : null}
            <Pressable
                testID={undoTestID}
                accessibilityRole="button"
                accessibilityLabel={undoLabel}
                onPress={onUndo}
                // STATIC style: a function style on a Pressable is dropped on
                // device in this app. The frame is the target, and the label
                // sits at its leading edge so it still lines up with the title.
                style={{
                    minHeight: UNDO_TARGET_PT,
                    minWidth: UNDO_TARGET_PT,
                    justifyContent: 'center',
                    alignItems: 'flex-start',
                    alignSelf: 'flex-start',
                }}
            >
                <Text
                    style={{
                        color: TOAST_ACCENT.success ?? TOAST_TITLE_COLOR,
                        fontWeight: '800',
                        textDecorationLine: 'underline',
                    }}
                >
                    {undoLabel}
                </Text>
            </Pressable>
        </Toast>
    );
}
