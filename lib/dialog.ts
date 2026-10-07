// The imperative way to show the app's dialog from plain code (no component in
// reach), replacing `Alert.alert`: owner rule, the app draws no native alerts.
// `DialogHost` (components/ui/confirm-dialog, mounted once in app/_layout.tsx)
// renders the front request with ConfirmDialog.
//
// A component that owns its own open state uses <ConfirmDialog> directly.
// Import-light on purpose (zustand only): lib/intercom.ts reaches this lazily.

import { create } from 'zustand';

export interface DialogOptions {
    title: string;
    body?: string;
    /** A red consequence line under the body. */
    warning?: string;
    confirmLabel: string;
    /** Omit for a one-button notice; the scrim and Back then confirm. */
    cancelLabel?: string;
    destructive?: boolean;
}

interface DialogRequest extends DialogOptions {
    id: number;
    resolve: (confirmed: boolean) => void;
}

interface DialogQueue {
    queue: DialogRequest[];
}

export const useDialogQueue = create<DialogQueue>(() => ({ queue: [] }));

let nextId = 1;

/** Shows the dialog (after any already open). Resolves true on confirm, false
 *  on cancel, a scrim tap or Back. A one-button notice always resolves true. */
export function showDialog(options: DialogOptions): Promise<boolean> {
    return new Promise((resolve) => {
        const request: DialogRequest = { ...options, id: nextId++, resolve };
        useDialogQueue.setState((s) => ({ queue: [...s.queue, request] }));
    });
}

/** The host's answer for the front request. */
export function settleDialog(id: number, confirmed: boolean): void {
    const { queue } = useDialogQueue.getState();
    const request = queue.find((r) => r.id === id);
    if (!request) return;
    useDialogQueue.setState({ queue: queue.filter((r) => r.id !== id) });
    request.resolve(request.cancelLabel === undefined ? true : confirmed);
}
