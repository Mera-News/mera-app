/* eslint-disable @typescript-eslint/no-require-imports */
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
// FlatList pulls RN's ScrollView native-component file, which jest-expo
// mis-transforms: proxy RN so ScrollView is a plain View (PublicationPreferences recipe).
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    const StubScrollView = ({ children, ...rest }: any) => ReactLib.createElement(actual.View, rest, children);
    StubScrollView.Context = ReactLib.createContext(null);
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') return StubScrollView;
            return (target as any)[prop];
        },
    });
});
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });

import NotificationHourWheel, { formatHourLabel } from '../NotificationHourWheel';

describe('formatHourLabel', () => {
    it('pads 24-hour times and uses the locale for 12-hour ones', () => {
        expect(formatHourLabel(8, true)).toBe('08:00');
        expect(formatHourLabel(0, true)).toBe('00:00');
        expect(formatHourLabel(18, false, 'en-US')).toBe('6 PM');
        expect(formatHourLabel(0, false, 'en-US')).toBe('12 AM');
    });

    it('falls back to English on a malformed language tag', () => {
        expect(formatHourLabel(13, false, '!!')).toBe('1 PM');
    });
});

describe('NotificationHourWheel', () => {
    const format = (h: number) => formatHourLabel(h, true);

    it('is one adjustable control that speaks the outlined hour', () => {
        const onCursorChange = jest.fn();
        const r = render(
            <NotificationHourWheel
                cursorHour={23}
                onCursorChange={onCursorChange}
                pickedHours={[]}
                format={format}
                accessibilityLabel="Time to add"
            />,
        );
        const wheel = r.getByTestId('hour-wheel');
        expect(wheel.props.accessibilityRole).toBe('adjustable');
        expect(wheel.props.accessibilityValue).toEqual({ text: '23:00' });
        fireEvent(wheel, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
        expect(onCursorChange).toHaveBeenLastCalledWith(0);
        fireEvent(wheel, 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } });
        expect(onCursorChange).toHaveBeenLastCalledWith(22);
    });

    it('moves the cursor to a tapped row', () => {
        const onCursorChange = jest.fn();
        const r = render(
            <NotificationHourWheel
                cursorHour={8}
                onCursorChange={onCursorChange}
                pickedHours={[8]}
                format={format}
                accessibilityLabel="Time to add"
            />,
        );
        fireEvent.press(r.getAllByTestId('hour-wheel-row-9')[0]);
        expect(onCursorChange).toHaveBeenCalledWith(9);
    });
});
