/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View testID={`icon-${p.name}`} /> };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text };
});

import NewStoriesPill from '../NewStoriesPill';

describe('NewStoriesPill', () => {
    it('renders nothing when there is nothing new', () => {
        const { queryByTestId } = render(<NewStoriesPill visible={false} onPress={jest.fn()} bottom={80} />);
        expect(queryByTestId('feed-new-stories-pill')).toBeNull();
    });

    it('carries the refresh glyph, not an arrow', () => {
        const { getByTestId, queryByTestId } = render(<NewStoriesPill visible onPress={jest.fn()} bottom={80} />);
        expect(getByTestId('icon-refresh')).toBeTruthy();
        expect(queryByTestId('icon-arrow-downward')).toBeNull();
    });

    it('is a 44pt labelled button that fires onPress on tap', () => {
        const onPress = jest.fn();
        const { getByTestId } = render(<NewStoriesPill visible onPress={onPress} bottom={80} />);
        const pill = getByTestId('feed-new-stories-pill');
        expect(pill.props.accessibilityLabel).toBe('feed.newStoriesPill');
        const style = StyleSheet.flatten(
            typeof pill.props.style === 'function' ? pill.props.style({ pressed: false }) : pill.props.style,
        ) as { minHeight?: number };
        expect(style.minHeight).toBeGreaterThanOrEqual(44);
        fireEvent.press(pill);
        expect(onPress).toHaveBeenCalledTimes(1);
    });
});
