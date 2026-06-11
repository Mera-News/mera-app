import { renderHook } from '@testing-library/react-native';
import { useConfigPanelStore, useConfigPanelIsOpen, useConfigPanelActiveTab } from '../config-panel-store';

describe('useConfigPanelStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Reset to known initial state
        useConfigPanelStore.setState({ isOpen: false, activeTab: 'persona' });
    });

    // ── initial state ──────────────────────────────────────────────────────
    it('starts closed with persona as active tab', () => {
        const state = useConfigPanelStore.getState();
        expect(state.isOpen).toBe(false);
        expect(state.activeTab).toBe('persona');
    });

    // ── openPanel ─────────────────────────────────────────────────────────
    it('openPanel sets isOpen to true', () => {
        useConfigPanelStore.getState().openPanel();
        expect(useConfigPanelStore.getState().isOpen).toBe(true);
    });

    it('openPanel is idempotent when already open', () => {
        useConfigPanelStore.getState().openPanel();
        useConfigPanelStore.getState().openPanel();
        expect(useConfigPanelStore.getState().isOpen).toBe(true);
    });

    // ── closePanel ────────────────────────────────────────────────────────
    it('closePanel sets isOpen to false', () => {
        useConfigPanelStore.getState().openPanel();
        useConfigPanelStore.getState().closePanel();
        expect(useConfigPanelStore.getState().isOpen).toBe(false);
    });

    it('closePanel is idempotent when already closed', () => {
        useConfigPanelStore.getState().closePanel();
        expect(useConfigPanelStore.getState().isOpen).toBe(false);
    });

    // ── setActiveTab ──────────────────────────────────────────────────────
    it('setActiveTab("sources") updates activeTab', () => {
        useConfigPanelStore.getState().setActiveTab('sources');
        expect(useConfigPanelStore.getState().activeTab).toBe('sources');
    });

    it('setActiveTab("preferences") updates activeTab', () => {
        useConfigPanelStore.getState().setActiveTab('preferences');
        expect(useConfigPanelStore.getState().activeTab).toBe('preferences');
    });

    it('setActiveTab("persona") resets to default tab', () => {
        useConfigPanelStore.getState().setActiveTab('sources');
        useConfigPanelStore.getState().setActiveTab('persona');
        expect(useConfigPanelStore.getState().activeTab).toBe('persona');
    });

    it('setActiveTab does not affect isOpen', () => {
        useConfigPanelStore.getState().openPanel();
        useConfigPanelStore.getState().setActiveTab('sources');
        expect(useConfigPanelStore.getState().isOpen).toBe(true);
    });

    // ── selector hooks (exported) ──────────────────────────────────────────
    it('useConfigPanelIsOpen returns isOpen value', () => {
        const { result } = renderHook(() => useConfigPanelIsOpen());
        expect(result.current).toBe(false);
    });

    it('useConfigPanelActiveTab returns activeTab value', () => {
        const { result } = renderHook(() => useConfigPanelActiveTab());
        expect(result.current).toBe('persona');
    });
});
