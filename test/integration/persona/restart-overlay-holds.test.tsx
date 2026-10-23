// Overlay primitives and typed-text fields hold a restart off while open / non-empty, and release on close,
// clear and unmount. Real app-restart; mocked: expo-updates (edge) and the RN Modal native spec.
import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { HelpModal } from '@/components/ui/help-modal';
import { Modal, ModalBackdrop, ModalBody, ModalContent } from '@/components/ui/modal';
import { Popover, PopoverBackdrop, PopoverBody, PopoverContent } from '@/components/ui/popover';
import { PromptInput } from '@/components/ui/chat-ai';
import SourceSearch from '@/components/custom/publication-preferences/SourceSearch';
import { __resetAppRestartForTests, activeHolds, restartWouldReload } from '@/lib/app-restart';
import { initI18nEn } from '@/test/helpers';

jest.mock('react-native/Libraries/Modal/Modal', () => {
    const { View } = jest.requireActual('react-native');
    return { __esModule: true, default: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) => (visible ? <View>{children}</View> : null) };
});
// The shared Reanimated mock has no useReducedMotion, which the sheet and help card read.
jest.mock('react-native-reanimated', () => {
    const actual = jest.requireActual('react-native-reanimated');
    return { ...actual, __esModule: true, default: actual.default ?? actual, useReducedMotion: () => true };
});
jest.mock('expo-updates', () => ({
    isEnabled: true,
    updateId: null,
    createdAt: null,
    isEmbeddedLaunch: false,
    latestContext: {},
    reloadAsync: async () => {},
    checkForUpdateAsync: async () => ({ isAvailable: false }),
    fetchUpdateAsync: async () => ({ isNew: false }),
}));

const setDev = (v: boolean) => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = v;
};

describe('restart holds on overlays and typed text', () => {
    beforeAll(() => initI18nEn());
    beforeEach(() => {
        __resetAppRestartForTests();
        setDev(false);
    });
    afterEach(() => setDev(true));

    /** Closed holds nothing, open holds `label`, closed again and unmount release it; then a restart can reload. */
    const overlayCase = (name: string, label: string, el: (open: boolean) => React.ReactElement) =>
        it(`${name} holds ${label} only while open`, () => {
            const view = render(el(false));
            expect(activeHolds()).not.toContain(label);
            view.rerender(el(true));
            expect(activeHolds()).toContain(label);
            view.rerender(el(false));
            expect(activeHolds()).not.toContain(label);
            view.rerender(el(true));
            view.unmount();
            expect(activeHolds()).not.toContain(label);
            expect(restartWouldReload('ota')).toBe(true);
        });

    overlayCase('kit Modal', 'overlay:dialog', (open) => (
        <Modal isOpen={open} onClose={() => {}}>
            <ModalBackdrop />
            <ModalContent>
                <ModalBody>
                    <Text>x</Text>
                </ModalBody>
            </ModalContent>
        </Modal>
    ));
    overlayCase('BottomSheet', 'overlay:sheet', (open) => (
        <BottomSheet open={open} onClose={() => {}}>
            <Text>x</Text>
        </BottomSheet>
    ));
    overlayCase('HelpModal', 'overlay:help', (open) => (
        <HelpModal open={open} onClose={() => {}} title="t">
            <Text>x</Text>
        </HelpModal>
    ));
    overlayCase('Popover', 'overlay:popover', (open) => (
        <Popover isOpen={open} onClose={() => {}} trigger={(p) => <Text {...p}>t</Text>}>
            <PopoverBackdrop />
            <PopoverContent>
                <PopoverBody>
                    <Text>x</Text>
                </PopoverBody>
            </PopoverContent>
        </Popover>
    ));

    it('chat composer holds draft:chat while text is non-empty, hard', () => {
        render(<PromptInput onSubmit={() => {}} placeholder="ask" />);
        expect(activeHolds('language')).not.toContain('draft:chat');
        const input = screen.getByPlaceholderText('ask');
        fireEvent.changeText(input, 'hello');
        expect(activeHolds('language')).toContain('draft:chat');
        expect(restartWouldReload('ota')).toBe(false);
        fireEvent.changeText(input, '   ');
        expect(activeHolds()).not.toContain('draft:chat');
        expect(restartWouldReload('ota')).toBe(true);
    });

    it('source search holds draft:source-search while typed, released on clear and unmount', async () => {
        const view = render(<SourceSearch />);
        const input = view.UNSAFE_getByProps({ value: '' });
        await act(async () => fireEvent.changeText(input, 'bbc'));
        expect(activeHolds('language')).toContain('draft:source-search');
        await act(async () => fireEvent.changeText(view.UNSAFE_getByProps({ value: 'bbc' }), ''));
        expect(activeHolds()).not.toContain('draft:source-search');
        await act(async () => fireEvent.changeText(view.UNSAFE_getByProps({ value: '' }), 'bbc'));
        view.unmount();
        expect(activeHolds()).not.toContain('draft:source-search');
        expect(restartWouldReload('ota')).toBe(true);
    });
});
