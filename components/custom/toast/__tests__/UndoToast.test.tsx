/**
 * THE undo toast: one look for every "done, with Undo" confirmation, and an
 * Undo control whose WHOLE 44pt frame is the target. A device run found taps on
 * the Undo text doing nothing while the frame centre worked.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('@/components/ui/toast', () => {
    const R = require('react');
    const { View } = require('react-native');
    return {
        Toast: (p: any) => R.createElement(View, { testID: `toast-${p.action}` }, p.children),
        TOAST_ACCENT: { success: '#84D3A2', info: '#32B4F4' },
    };
});

import UndoToast, { UNDO_TARGET_PT } from '../UndoToast';

describe('UndoToast', () => {
    it('is the success style: the green check card', () => {
        const { getByTestId } = render(
            <UndoToast title="Done" undoLabel="Undo" undoTestID="x-undo" onUndo={jest.fn()} />,
        );
        expect(getByTestId('toast-success')).toBeTruthy();
    });

    it('gives the Undo control a frame of at least 44pt each way', () => {
        expect(UNDO_TARGET_PT).toBeGreaterThanOrEqual(44);
        const { getByTestId } = render(
            <UndoToast title="Done" undoLabel="Undo" undoTestID="x-undo" onUndo={jest.fn()} />,
        );
        const style = StyleSheet.flatten(getByTestId('x-undo').props.style);
        expect(style.minHeight).toBeGreaterThanOrEqual(44);
        expect(style.minWidth).toBeGreaterThanOrEqual(44);
        expect(style.justifyContent).toBe('center');
    });

    it('fires onUndo from a press on the control, and names it for VoiceOver', () => {
        const onUndo = jest.fn();
        const { getByTestId, getByLabelText } = render(
            <UndoToast title="Done" undoLabel="Undo" undoTestID="x-undo" onUndo={onUndo} />,
        );
        fireEvent.press(getByTestId('x-undo'));
        expect(onUndo).toHaveBeenCalledTimes(1);
        expect(getByLabelText('Undo')).toBeTruthy();
    });

    it('renders the body only when given', () => {
        const { queryByText, rerender } = render(
            <UndoToast title="Done" undoLabel="Undo" undoTestID="x-undo" onUndo={jest.fn()} />,
        );
        expect(queryByText('More detail')).toBeNull();
        rerender(
            <UndoToast
                title="Done"
                body="More detail"
                undoLabel="Undo"
                undoTestID="x-undo"
                onUndo={jest.fn()}
            />,
        );
        expect(queryByText('More detail')).toBeTruthy();
    });
});
