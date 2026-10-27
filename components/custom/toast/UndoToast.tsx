import { Undo } from 'lucide-react-native';
import React, { useState } from 'react';
import MeraToast from './MeraToast';

/**
 * THE UNDO TOAST: every "done, with Undo" confirmation (the feedback leaf's
 * "Got it: feed updated", the ••• menu's "Fewer from <source>"). A success
 * MeraToast with one Undo action: inline when there is only a title, a pill
 * under the text when there is a body. Show it through
 * `toastManager.showUndoToast`, never hand-built.
 *
 * Undo swaps the content IN PLACE to `undoneTitle` ("Change undone"), which the
 * manager holds for 1.4 s before the card leaves. `onUndo` resolves whether to
 * swap (false: the undo was refused, or there is no undone title, and the card
 * has already been closed). `undone` is the manager's record of a swap, so a
 * fresh mount of the same card (the deck's exit clone) keeps the swapped face.
 */
export interface UndoToastProps {
    title: string;
    body?: string;
    undoLabel: string;
    undoneTitle?: string;
    /** Required: a reusable primitive carries no default testID. */
    undoTestID: string;
    undone?: boolean;
    onUndo: () => Promise<boolean>;
}

export default function UndoToast({ title, body, undoLabel, undoneTitle, undoTestID, undone = false, onUndo }: UndoToastProps) {
    const [swapped, setSwapped] = useState(undone);
    if ((swapped || undone) && undoneTitle) return <MeraToast tone="neutral" icon={Undo} title={undoneTitle} />;
    return (
        <MeraToast
            tone="success"
            title={title}
            body={body}
            actions={[
                {
                    label: undoLabel,
                    testID: undoTestID,
                    onPress: () => {
                        void onUndo().then((swap) => {
                            if (swap) setSwapped(true);
                        });
                    },
                },
            ]}
        />
    );
}
