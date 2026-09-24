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

import UndoToast from '@/components/custom/toast/UndoToast';
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

    it('lets the front toast run its own timeout when the undo toast arrives mid-read', () => {
        const fewer = show({ duration: 6000, render: () => null });
        jest.advanceTimersByTime(4300);
        toastManager.showUndoToast({
            title: 'Got it: feed updated',
            undoLabel: 'Undo',
            undoneTitle: 'Change undone',
            onUndo: () => undefined,
        });
        jest.advanceTimersByTime(1600);
        expect(ids()[0]).toBe(fewer);
        expect(ids()).toHaveLength(2);
        jest.advanceTimersByTime(100);
        expect(ids()).toHaveLength(1);
        expect(ids()[0]).not.toBe(fewer);
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

describe('one undo-toast style', () => {
    const rendered = () => {
        const entry = useToastQueue.getState().entries[0];
        return entry.render({ id: entry.id }) as { type: unknown; props: Record<string, unknown> };
    };

    it('renders every undo toast through UndoToast, the leaf style', () => {
        toastManager.showUndoToast({
            title: 'Got it: feed updated',
            undoLabel: 'Undo',
            undoneTitle: 'Change undone',
            onUndo: () => undefined,
        });
        const el = rendered();
        expect(el.type).toBe(UndoToast);
        expect(el.props.undoTestID).toBe('feedback-undo');
    });

    it("keeps a caller's own Undo testID", () => {
        toastManager.showUndoToast({
            title: "You'll see less from AD.nl.",
            undoLabel: 'Undo',
            undoTestID: 'article-menu-undo',
            onUndo: () => undefined,
        });
        expect(rendered().props.undoTestID).toBe('article-menu-undo');
    });

    it('closes itself on Undo, and follows up only when given an undone title', async () => {
        const onUndo = jest.fn();
        toastManager.showUndoToast({ title: 'Less from AD.nl', undoLabel: 'Undo', onUndo });
        const el = rendered();
        (el.props.onUndo as () => void)();
        await Promise.resolve();
        await Promise.resolve();
        expect(onUndo).toHaveBeenCalledTimes(1);
        expect(ids()).toEqual([]);
    });

    it('shows NO undone follow-up when onUndo resolves false (a newer change owns the value)', async () => {
        toastManager.showUndoToast({
            title: 'Less from AD.nl',
            undoLabel: 'Undo',
            undoneTitle: 'Change undone',
            onUndo: async () => false,
        });
        (rendered().props.onUndo as () => void)();
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
        expect(ids()).toEqual([]);
    });

    it('still shows the undone follow-up when onUndo returns true or nothing', async () => {
        for (const result of [true, undefined]) {
            closeAll();
            toastManager.showUndoToast({
                title: 'Less from AD.nl',
                undoLabel: 'Undo',
                undoneTitle: 'Change undone',
                onUndo: () => result,
            });
            (rendered().props.onUndo as () => void)();
            for (let i = 0; i < 5; i += 1) await Promise.resolve();
            expect(ids()).toHaveLength(1);
        }
    });
});
