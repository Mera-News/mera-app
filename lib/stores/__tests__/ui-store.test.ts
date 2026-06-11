import { renderHook } from '@testing-library/react-native';
import { useUIStore, useLogoutModal, useDeleteAccountModal } from '../ui-store';

describe('useUIStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        useUIStore.getState().resetUIState();
    });

    // ── initial state ──────────────────────────────────────────────────────
    it('starts with all modals closed and not processing', () => {
        const { modals } = useUIStore.getState();
        expect(modals.logout.isOpen).toBe(false);
        expect(modals.logout.isProcessing).toBe(false);
        expect(modals.deleteAccount.isOpen).toBe(false);
        expect(modals.deleteAccount.step).toBe('initial');
        expect(modals.deleteAccount.isProcessing).toBe(false);
    });

    // ── openModal ──────────────────────────────────────────────────────────
    it('openModal("logout") opens logout modal', () => {
        useUIStore.getState().openModal('logout');
        expect(useUIStore.getState().modals.logout.isOpen).toBe(true);
    });

    it('openModal("deleteAccount") opens deleteAccount modal and resets step to initial', () => {
        // Pre-set step to confirm to verify reset
        useUIStore.getState().setDeleteAccountStep('confirm');
        useUIStore.getState().openModal('deleteAccount');
        const { deleteAccount } = useUIStore.getState().modals;
        expect(deleteAccount.isOpen).toBe(true);
        expect(deleteAccount.step).toBe('initial');
    });

    it('openModal("logout") preserves other modal state', () => {
        useUIStore.getState().openModal('logout');
        expect(useUIStore.getState().modals.deleteAccount.isOpen).toBe(false);
    });

    // ── closeModal ─────────────────────────────────────────────────────────
    it('closeModal("logout") closes logout modal and resets isProcessing', () => {
        useUIStore.getState().openModal('logout');
        useUIStore.getState().setModalProcessing('logout', true);
        useUIStore.getState().closeModal('logout');
        const { logout } = useUIStore.getState().modals;
        expect(logout.isOpen).toBe(false);
        expect(logout.isProcessing).toBe(false);
    });

    it('closeModal("deleteAccount") closes modal, resets step, and resets isProcessing', () => {
        useUIStore.getState().openModal('deleteAccount');
        useUIStore.getState().setDeleteAccountStep('confirm');
        useUIStore.getState().setModalProcessing('deleteAccount', true);
        useUIStore.getState().closeModal('deleteAccount');
        const { deleteAccount } = useUIStore.getState().modals;
        expect(deleteAccount.isOpen).toBe(false);
        expect(deleteAccount.step).toBe('initial');
        expect(deleteAccount.isProcessing).toBe(false);
    });

    // ── setDeleteAccountStep ───────────────────────────────────────────────
    it('setDeleteAccountStep updates step on deleteAccount modal', () => {
        useUIStore.getState().setDeleteAccountStep('confirm');
        expect(useUIStore.getState().modals.deleteAccount.step).toBe('confirm');
    });

    it('setDeleteAccountStep("initial") resets step', () => {
        useUIStore.getState().setDeleteAccountStep('confirm');
        useUIStore.getState().setDeleteAccountStep('initial');
        expect(useUIStore.getState().modals.deleteAccount.step).toBe('initial');
    });

    // ── setModalProcessing ─────────────────────────────────────────────────
    it('setModalProcessing sets isProcessing to true for logout', () => {
        useUIStore.getState().setModalProcessing('logout', true);
        expect(useUIStore.getState().modals.logout.isProcessing).toBe(true);
    });

    it('setModalProcessing sets isProcessing to false for logout', () => {
        useUIStore.getState().setModalProcessing('logout', true);
        useUIStore.getState().setModalProcessing('logout', false);
        expect(useUIStore.getState().modals.logout.isProcessing).toBe(false);
    });

    it('setModalProcessing does not affect other modal', () => {
        useUIStore.getState().setModalProcessing('logout', true);
        expect(useUIStore.getState().modals.deleteAccount.isProcessing).toBe(false);
    });

    it('setModalProcessing sets isProcessing for deleteAccount', () => {
        useUIStore.getState().setModalProcessing('deleteAccount', true);
        expect(useUIStore.getState().modals.deleteAccount.isProcessing).toBe(true);
    });

    // ── resetUIState ───────────────────────────────────────────────────────
    it('resetUIState restores all defaults after mutations', () => {
        useUIStore.getState().openModal('logout');
        useUIStore.getState().openModal('deleteAccount');
        useUIStore.getState().setDeleteAccountStep('confirm');
        useUIStore.getState().setModalProcessing('logout', true);
        useUIStore.getState().resetUIState();

        const { modals } = useUIStore.getState();
        expect(modals.logout.isOpen).toBe(false);
        expect(modals.logout.isProcessing).toBe(false);
        expect(modals.deleteAccount.isOpen).toBe(false);
        expect(modals.deleteAccount.step).toBe('initial');
        expect(modals.deleteAccount.isProcessing).toBe(false);
    });

    // ── selector hooks (exported) ──────────────────────────────────────────
    it('useLogoutModal selector returns logout modal slice', () => {
        const { result } = renderHook(() => useLogoutModal());
        expect(result.current.isOpen).toBe(false);
        expect(result.current.isProcessing).toBe(false);
    });

    it('useDeleteAccountModal selector returns deleteAccount slice', () => {
        const { result } = renderHook(() => useDeleteAccountModal());
        expect(result.current.isOpen).toBe(false);
        expect(result.current.step).toBe('initial');
    });
});
