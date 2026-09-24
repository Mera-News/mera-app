// applyLeafActions: the ONE path from a tree leaf to persona writes + the undo
// toast. The toast shows as soon as the persona write lands (the spend
// bookkeeping follows it), and its Undo reports whether anything was actually
// reverted: a compare-and-set revert refused because a newer change owns the
// value is `false`, so the toast shows no "Change undone" (batch 16).
const order: string[] = [];
const mockShowUndoToast = jest.fn((..._a: any[]) => order.push('toast'));
jest.mock('@/lib/toast-manager', () => ({ toastManager: { showUndoToast: (...a: any[]) => mockShowUndoToast(...a) } }));
jest.mock('@/lib/haptics', () => ({ hapticSuccess: jest.fn() }));
jest.mock('@/lib/i18n', () => ({ __esModule: true, default: { t: (_k: string, o: any) => o.defaultValue } }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
const mockApply = jest.fn(async (..._a: any[]) => {
    order.push('persona');
    return [
        { applied: true, changeLogId: 'cl-1' },
        { applied: true, changeLogId: 'cl-2' },
    ];
});
jest.mock('@/lib/database/services/persona-action-executor', () => ({ applyPersonaActions: (...a: any[]) => mockApply(...a) }));
const mockRecordIds = jest.fn(async (..._a: any[]) => {
    order.push('spend');
});
jest.mock('@/lib/database/services/article-feedback-service', () => ({
    recordFeedbackChangeLogIds: (...a: any[]) => mockRecordIds(...a),
    markFeedbackProcessedFor: jest.fn(async () => {}),
}));
const mockRevert = jest.fn(async (..._a: any[]) => true);
jest.mock('@/lib/database/services/persona-change-log-service', () => ({ revertChange: (...a: any[]) => mockRevert(...a) }));

import { applyLeafActions } from '../apply-leaf-actions';

const ACTIONS = [{ action_type: 'set_topic_weight', topicId: 't1', delta: -0.15 }] as any;

beforeEach(() => {
    jest.clearAllMocks();
    order.length = 0;
});

describe('applyLeafActions', () => {
    it('shows the undo toast as soon as the persona write lands, before the spend bookkeeping', async () => {
        await expect(applyLeafActions(ACTIONS, 'Not that important', { articleId: 'a1', sentiment: 'dislike' })).resolves.toBe(2);
        expect(order).toEqual(['persona', 'toast', 'spend']);
        expect(mockRecordIds).toHaveBeenCalledWith('a1', 'dislike', ['cl-1', 'cl-2']);
    });

    it('Undo reverts every change and reports true when any was reverted', async () => {
        await applyLeafActions(ACTIONS, 'x');
        const { onUndo } = mockShowUndoToast.mock.calls[0][0] as any;
        mockRevert.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        await expect(onUndo()).resolves.toBe(true);
        expect(mockRevert.mock.calls.map((c) => c[0])).toEqual(['cl-1', 'cl-2']);
    });

    it('Undo reports false when every revert was refused (a newer change owns the value)', async () => {
        await applyLeafActions(ACTIONS, 'x');
        const { onUndo } = mockShowUndoToast.mock.calls[0][0] as any;
        mockRevert.mockResolvedValue(false);
        await expect(onUndo()).resolves.toBe(false);
    });
});
