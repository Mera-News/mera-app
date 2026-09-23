// F41: the one header for pushed pages. The back button says what it does.
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
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });

import DrillDownHeader from '../DrillDownHeader';

describe('DrillDownHeader', () => {
    it('labels the back button Back, not the page title', () => {
        const onBack = jest.fn();
        const r = render(<DrillDownHeader title="Display" onBack={onBack} backTestID="back" />);
        const back = r.getByTestId('back');
        expect(back.props.accessibilityLabel).toBe('common.back');
        fireEvent.press(back);
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('announces a locked back button as disabled and ignores the press', () => {
        const onBack = jest.fn();
        const r = render(<DrillDownHeader title="Language" onBack={onBack} backTestID="back" backDisabled />);
        expect(r.getByTestId('back').props.accessibilityState).toEqual({ disabled: true });
        fireEvent.press(r.getByTestId('back'));
        expect(onBack).not.toHaveBeenCalled();
    });

    it('renders no back button when the page is a root', () => {
        const r = render(<DrillDownHeader title="Mera Protocol" />);
        expect(r.queryByLabelText('common.back')).toBeNull();
        expect(r.getByText('Mera Protocol')).toBeTruthy();
    });
});
