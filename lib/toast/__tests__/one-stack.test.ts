/**
 * ONE TOAST MECHANISM: every `toastManager` method lands in the single top
 * stack, BEHIND whatever card is already showing. This drives the real
 * manager into the real queue (only the rendered primitives are stubbed), so
 * a method that picks its own placement or lane cannot pass here.
 *
 * `showUndoToast` is the feedback sheet's leaf acknowledgement ("More from this
 * publication" and every other applied leaf). It used to open a second deck at
 * the bottom of the screen with its own timer, beside the top one.
 */
jest.mock('@/components/ui/toast', () => ({
    Toast: 'MockToast',
    TOAST_ACCENT: { success: '#0f0' },
}));
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), captureException: jest.fn() },
}));

import { toastManager } from '@/lib/toast-manager';
import { closeAll, resetToastQueue, show, toastApi, useToastQueue } from '../toast-queue';

const ids = () => useToastQueue.getState().entries.map((entry) => entry.id);

beforeEach(() => {
    jest.useFakeTimers();
    resetToastQueue();
    toastManager.setToastInstance(toastApi);
    toastManager.resetDebounce();
});

afterEach(() => {
    closeAll();
    jest.useRealTimers();
});

describe('one top stack', () => {
    it('queues the undo toast BEHIND a toast that is already showing', () => {
        const showing = show({ duration: 5000, render: () => null });
        toastManager.showUndoToast({
            title: 'Got it: feed updated',
            undoLabel: 'Undo',
            undoneTitle: 'Change undone',
            onUndo: () => undefined,
        });
        const state = useToastQueue.getState();
        expect(Object.keys(state)).toEqual(['entries']);
        expect(ids()).toHaveLength(2);
        expect(ids()[0]).toBe(showing);
    });

    it('queues an info toast BEHIND a toast that is already showing', () => {
        const showing = show({ duration: 5000, render: () => null });
        toastManager.showInfo('Thanks for the feedback');
        expect(ids()).toHaveLength(2);
        expect(ids()[0]).toBe(showing);
    });

    it('keeps every manager method in the same stack, in arrival order', () => {
        toastManager.showSuccess('Saved', 'Done');
        toastManager.showInfo('Hint');
        toastManager.showUndoToast({
            title: 'Applied',
            undoLabel: 'Undo',
            undoneTitle: 'Undone',
            onUndo: () => undefined,
        });
        toastManager.showError('Oops', 'Broke');
        expect(ids()).toHaveLength(4);
        // The first arrival still holds the front slot (FIFO, owner decision).
        const seqs = useToastQueue.getState().entries.map((entry) => entry.seq);
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    });
});
