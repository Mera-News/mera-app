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

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('@/components/ui/box', () => {
    const { View } = require('react-native');
    return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable };
});
jest.mock('@/components/ui/input', () => {
    const { View, TextInput } = require('react-native');
    return {
        Input: (p: any) => <View {...p} />,
        InputField: (p: any) => <TextInput {...p} />,
        InputSlot: (p: any) => <View {...p} />,
    };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});

import ExploreSearchBar from '../ExploreSearchBar';

describe('ExploreSearchBar', () => {
    it('renders the wrapper testID (InputField swallows its own)', () => {
        const { getByTestId } = render(
            <ExploreSearchBar query="" onChangeQuery={jest.fn()} onClose={jest.fn()} />,
        );
        expect(getByTestId('explore-search-input')).toBeTruthy();
    });

    it('shows the placeholder and current query value', () => {
        const { getByPlaceholderText } = render(
            <ExploreSearchBar query="modi india" onChangeQuery={jest.fn()} onClose={jest.fn()} />,
        );
        const input = getByPlaceholderText('explore.searchPlaceholder');
        expect(input.props.value).toBe('modi india');
    });

    it('calls onChangeQuery as the user types', () => {
        const onChangeQuery = jest.fn();
        const { getByPlaceholderText } = render(
            <ExploreSearchBar query="" onChangeQuery={onChangeQuery} onClose={jest.fn()} />,
        );
        fireEvent.changeText(getByPlaceholderText('explore.searchPlaceholder'), 'india');
        expect(onChangeQuery).toHaveBeenCalledWith('india');
    });

    it('autofocuses, so the tap that revealed it also raises the keyboard', () => {
        const { getByPlaceholderText } = render(
            <ExploreSearchBar query="" onChangeQuery={jest.fn()} onClose={jest.fn()} />,
        );
        expect(getByPlaceholderText('explore.searchPlaceholder').props.autoFocus).toBe(true);
    });

    it('shows the close control even with an EMPTY query — it is the only way back', () => {
        const { getByTestId } = render(
            <ExploreSearchBar query="" onChangeQuery={jest.fn()} onClose={jest.fn()} />,
        );
        expect(getByTestId('explore-search-close')).toBeTruthy();
    });

    it('calls onClose when the ✕ is pressed', () => {
        const onClose = jest.fn();
        const { getByTestId } = render(
            <ExploreSearchBar query="india" onChangeQuery={jest.fn()} onClose={onClose} />,
        );
        fireEvent.press(getByTestId('explore-search-close'));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
