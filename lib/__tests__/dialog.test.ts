import { settleDialog, showDialog, useDialogQueue } from '../dialog';

describe('dialog queue', () => {
    beforeEach(() => useDialogQueue.setState({ queue: [] }));

    it('queues in order and resolves each with its answer', async () => {
        const a = showDialog({ title: 'A', confirmLabel: 'Yes', cancelLabel: 'No' });
        const b = showDialog({ title: 'B', confirmLabel: 'Yes', cancelLabel: 'No' });
        const [first, second] = useDialogQueue.getState().queue;
        expect(first.title).toBe('A');
        settleDialog(first.id, false);
        expect(useDialogQueue.getState().queue.map((r) => r.title)).toEqual(['B']);
        settleDialog(second.id, true);
        await expect(a).resolves.toBe(false);
        await expect(b).resolves.toBe(true);
        expect(useDialogQueue.getState().queue).toHaveLength(0);
    });

    it('a one-button notice always resolves true, and a stale id is ignored', async () => {
        const n = showDialog({ title: 'N', confirmLabel: 'OK' });
        const [req] = useDialogQueue.getState().queue;
        settleDialog(req.id, false);
        settleDialog(req.id, false);
        await expect(n).resolves.toBe(true);
    });
});
