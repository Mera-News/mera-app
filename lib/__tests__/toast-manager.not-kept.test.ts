// Y11: the daily limit, a failed sync and a finished migration are no longer
// notices. No inbox row, no toast.
jest.mock('../logger', () => ({
    __esModule: true,
    default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), captureException: jest.fn() },
}));
const mockNotify = jest.fn(async () => null);
jest.mock('@/lib/database/services/notification-service', () => ({ notify: mockNotify }));
jest.mock('@/components/custom/notifications/NotifiedToast', () => ({
    __esModule: true,
    default: () => null,
    notifiedToastDurationMs: () => 4000,
}));

import { NOT_KEPT_NOTICE_TYPES, toastManager } from '../toast-manager';

describe('notices that are not kept', () => {
    const show = jest.fn(() => 't1');
    beforeEach(() => {
        mockNotify.mockClear();
        show.mockClear();
        (toastManager as any).toastInstance = { show, close: jest.fn(), closeAll: jest.fn(), isActive: () => false };
    });

    it.each([...NOT_KEPT_NOTICE_TYPES])('%s writes no row and shows nothing', async (type) => {
        await toastManager.showNotifiedToast({ type, source: 'feed-sync', title: 'x', body: 'y' });
        expect(mockNotify).not.toHaveBeenCalled();
        expect(show).not.toHaveBeenCalled();
    });

    // The row is written through a dynamic import, which this jest config
    // cannot run, so the positive case asserts the toast only.
    it('a notice that needs you still shows', async () => {
        await toastManager.showNotifiedToast({ type: 'hygiene', source: 'hygiene', title: 'x', body: 'y' });
        expect(show).toHaveBeenCalledTimes(1);
    });
});
