/* eslint-disable @typescript-eslint/no-require-imports */
// Owner, in prod: "swipe right left is also a gesture to open article". RN's
// Pressable fires onPress on ANY release inside its rect, however far the
// finger travelled, and a full-width card holds the whole of a sideways drag.
// A card opens only on a TAP: a release more than TAP_SLOP from where the
// press began is a drag, not a tap. The long-press menu is unchanged.

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable };
});

import PressableCard from '../PressableCard';
import { TAP_SLOP } from '../use-tap-guard';

const at = (x: number, y: number) => ({ nativeEvent: { pageX: x, pageY: y } });

function setup() {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    const r = render(<PressableCard testID="card" onPress={onPress} onLongPress={onLongPress} />);
    return { card: r.getByTestId('card'), onPress, onLongPress };
}

describe('PressableCard: a card opens on a tap, never on a drag', () => {
    it('a sideways drag across the card does not open it', () => {
        const { card, onPress } = setup();
        fireEvent(card, 'pressIn', at(40, 300));
        fireEvent(card, 'press', at(260, 306));
        expect(onPress).not.toHaveBeenCalled();
    });

    it('a drag just past the slop, either axis, does not open it', () => {
        const { card, onPress } = setup();
        fireEvent(card, 'pressIn', at(100, 300));
        fireEvent(card, 'press', at(100 - (TAP_SLOP + 1), 300));
        fireEvent(card, 'pressIn', at(100, 300));
        fireEvent(card, 'press', at(100, 300 + TAP_SLOP + 1));
        expect(onPress).not.toHaveBeenCalled();
    });

    it('a tap, with the usual finger wobble, still opens it', () => {
        const { card, onPress } = setup();
        fireEvent(card, 'pressIn', at(100, 300));
        fireEvent(card, 'press', at(104, 297));
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('a press with no coordinates (accessibility activate) still opens it', () => {
        const { card, onPress } = setup();
        fireEvent.press(card);
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('the long-press menu still works', () => {
        const { card, onLongPress } = setup();
        fireEvent(card, 'pressIn', at(100, 300));
        fireEvent(card, 'longPress', at(100, 300));
        expect(onLongPress).toHaveBeenCalledTimes(1);
    });
});
