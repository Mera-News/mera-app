import { create } from 'zustand';

type ModalName = 'logout' | 'deleteAccount';
type DeleteAccountStep = 'initial' | 'confirm';

interface ModalState {
    logout: {
        isOpen: boolean;
        isProcessing: boolean;
    };
    deleteAccount: {
        isOpen: boolean;
        step: DeleteAccountStep;
        isProcessing: boolean;
    };
}

interface UIState {
    // Modal states
    modals: ModalState;

    // Actions - Modals
    openModal: (modal: ModalName) => void;
    closeModal: (modal: ModalName) => void;
    setDeleteAccountStep: (step: DeleteAccountStep) => void;
    setModalProcessing: (modal: ModalName, isProcessing: boolean) => void;

    // Reset
    resetUIState: () => void;
}

const initialModalState: ModalState = {
    logout: {
        isOpen: false,
        isProcessing: false,
    },
    deleteAccount: {
        isOpen: false,
        step: 'initial',
        isProcessing: false,
    },
};

export const useUIStore = create<UIState>((set) => ({
    modals: initialModalState,

    openModal: (modal) =>
        set((state) => ({
            modals: {
                ...state.modals,
                [modal]: {
                    ...state.modals[modal],
                    isOpen: true,
                    // Reset step to initial when opening deleteAccount modal
                    ...(modal === 'deleteAccount' ? { step: 'initial' as DeleteAccountStep } : {}),
                },
            },
        })),

    closeModal: (modal) =>
        set((state) => ({
            modals: {
                ...state.modals,
                [modal]: {
                    ...state.modals[modal],
                    isOpen: false,
                    isProcessing: false,
                    // Reset step when closing deleteAccount modal
                    ...(modal === 'deleteAccount' ? { step: 'initial' as DeleteAccountStep } : {}),
                },
            },
        })),

    setDeleteAccountStep: (step) =>
        set((state) => ({
            modals: {
                ...state.modals,
                deleteAccount: {
                    ...state.modals.deleteAccount,
                    step,
                },
            },
        })),

    setModalProcessing: (modal, isProcessing) =>
        set((state) => ({
            modals: {
                ...state.modals,
                [modal]: {
                    ...state.modals[modal],
                    isProcessing,
                },
            },
        })),

    resetUIState: () =>
        set({
            modals: initialModalState,
        }),
}));

// Selector hooks for optimized subscriptions
export const useLogoutModal = () => useUIStore((state) => state.modals.logout);
export const useDeleteAccountModal = () => useUIStore((state) => state.modals.deleteAccount);
