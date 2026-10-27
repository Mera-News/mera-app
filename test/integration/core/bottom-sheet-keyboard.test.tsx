// The kit BottomSheet's opt-in keyboard lift: a sheet holding a text field rides above the keyboard
// (a KeyboardAvoidingView inside the sheet cannot move the sheet). Only a sim capture proves the
// pixels; this pins who listens and when.
import React from 'react';
import { Keyboard, Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { BottomSheet } from '@/components/ui/bottom-sheet';

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

const events = (spy: jest.SpyInstance) => spy.mock.calls.map((c) => c[0]);

describe('BottomSheet avoidKeyboard', () => {
    afterEach(() => jest.restoreAllMocks());

    it('listens for the keyboard only when opted in and open, and stops on close', () => {
        const remove = jest.fn();
        const spy = jest.spyOn(Keyboard, 'addListener').mockReturnValue({ remove } as never);

        const view = render(
            <BottomSheet open onClose={() => {}} avoidKeyboard>
                <Text>field</Text>
            </BottomSheet>,
        );
        expect(events(spy)).toEqual(['keyboardWillShow', 'keyboardWillHide']);

        view.rerender(
            <BottomSheet open={false} onClose={() => {}} avoidKeyboard>
                <Text>field</Text>
            </BottomSheet>,
        );
        expect(remove).toHaveBeenCalledTimes(2);
    });

    it('a sheet without the prop never listens', () => {
        const spy = jest.spyOn(Keyboard, 'addListener');
        render(
            <BottomSheet open onClose={() => {}}>
                <Text>menu</Text>
            </BottomSheet>,
        );
        expect(events(spy)).not.toContain('keyboardWillShow');
    });
});
