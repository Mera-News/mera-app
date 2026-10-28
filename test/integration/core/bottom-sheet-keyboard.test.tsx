// The kit BottomSheet's opt-in keyboard lift: a sheet holding a text field rides above the keyboard
// (a KeyboardAvoidingView inside the sheet cannot move the sheet). Only a sim capture proves the
// pixels; this pins who listens and when.
import React from 'react';
import { Keyboard, Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { BottomSheet, keyboardLiftFor } from '@/components/ui/bottom-sheet';

jest.mock('react-native/Libraries/Modal/Modal', () => {
    const { View } = jest.requireActual('react-native');
    const MockModal = ({ visible, children }: { visible: boolean; children: React.ReactNode }) => (visible ? <View>{children}</View> : null);
    return { __esModule: true, default: MockModal };
});

// The shared Reanimated mock has no useReducedMotion, which the sheet reads.
jest.mock('react-native-reanimated', () => {
    const actual = jest.requireActual('react-native-reanimated');
    return { ...actual, __esModule: true, default: actual.default ?? actual, useReducedMotion: () => false };
});

// The window's own insets (iPhone 17 Pro portrait). A tab screen's context reports more at the bottom.
jest.mock('react-native-safe-area-context', () => ({
    ...jest.requireActual('react-native-safe-area-context'),
    initialWindowMetrics: { insets: { top: 62, bottom: 34, left: 0, right: 0 }, frame: { x: 0, y: 0, width: 402, height: 874 } },
}));

/** The real safe-area module needs a provider; this one stands in for a tab screen's context. */
const inTab = (el: React.ReactElement) => (
    <SafeAreaInsetsContext.Provider value={{ top: 62, bottom: 83, left: 0, right: 0 }}>{el}</SafeAreaInsetsContext.Provider>
);

const events = (spy: jest.SpyInstance) => spy.mock.calls.map((c) => c[0]);

describe('BottomSheet avoidKeyboard', () => {
    afterEach(() => jest.restoreAllMocks());

    it('listens for the keyboard only when opted in and open, and stops on close', () => {
        const remove = jest.fn();
        const spy = jest.spyOn(Keyboard, 'addListener').mockReturnValue({ remove } as never);

        const view = render(
            inTab(
                <BottomSheet open onClose={() => {}} avoidKeyboard>
                    <Text>field</Text>
                </BottomSheet>,
            ),
        );
        expect(events(spy)).toEqual(['keyboardWillShow', 'keyboardWillHide']);

        view.rerender(
            inTab(
                <BottomSheet open={false} onClose={() => {}} avoidKeyboard>
                    <Text>field</Text>
                </BottomSheet>,
            ),
        );
        expect(remove).toHaveBeenCalledTimes(2);
    });

    it('a sheet without the prop never listens', () => {
        const spy = jest.spyOn(Keyboard, 'addListener');
        render(
            inTab(
                <BottomSheet open onClose={() => {}}>
                    <Text>menu</Text>
                </BottomSheet>,
            ),
        );
        expect(events(spy)).not.toContain('keyboardWillShow');
    });
});

describe('keyboardLiftFor', () => {
    it('lifts by the keyboard minus the bottom safe area the sheet already pads for, so Cancel keeps its 8pt gap', () => {
        // iPhone 15: a 336pt keyboard over a 34pt home-indicator inset.
        expect(keyboardLiftFor(336, 34)).toBe(302);
        // No inset (older phones, Android): the whole keyboard.
        expect(keyboardLiftFor(260, 0)).toBe(260);
        // A closed keyboard never pushes the sheet down.
        expect(keyboardLiftFor(0, 34)).toBe(0);
    });
});

describe('the sheet bottom inset', () => {
    it("pads for the WINDOW's home indicator, not a tab screen's inset that includes the tab bar it covers", () => {
        // Inside a tab screen useSafeAreaInsets reports 34 + the 49pt tab bar; the sheet's Modal covers that bar.
        render(
            inTab(
                <BottomSheet open onClose={() => {}} testID="sheet">
                    <Text>menu</Text>
                </BottomSheet>,
            ),
        );
        const body = screen.getByTestId('sheet-content');
        const style = Object.assign({}, ...[body.props.style].flat(Infinity).filter(Boolean));
        expect(style.paddingBottom).toBe(34 + 8); // the window inset plus the 8pt content bottom
    });
});
