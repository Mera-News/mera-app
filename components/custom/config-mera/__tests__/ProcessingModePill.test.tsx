/* eslint-disable @typescript-eslint/no-require-imports */
// The On-device option carries a "Beta" pill on its icon; Cloud never does.
import { render } from '@testing-library/react-native';
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
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/lib/generated/graphql-types', () => ({ ProcessingMode: { OnDevice: 'ON_DEVICE', Cloud: 'CLOUD' } }));

import ProcessingModePill from '../ProcessingModePill';

const OnDevice = 'ON_DEVICE' as any;
const Cloud = 'CLOUD' as any;

it('shows Beta on On-device and says so to VoiceOver', () => {
    const r = render(<ProcessingModePill mode={OnDevice} selected={false} disabled={false} onPress={jest.fn()} />);
    expect(r.getByTestId('processing-mode-beta', { includeHiddenElements: true })).toBeTruthy();
    expect(r.getByTestId('processing-mode-on-device').props.accessibilityLabel).toBe(
        'meraProtocol.onDeviceMode, common.beta',
    );
});

it('never shows Beta on Cloud', () => {
    const r = render(<ProcessingModePill mode={Cloud} selected disabled={false} onPress={jest.fn()} />);
    expect(r.queryByTestId('processing-mode-beta', { includeHiddenElements: true })).toBeNull();
    expect(r.getByTestId('processing-mode-cloud').props.accessibilityLabel).toBe('meraProtocol.cloudMode');
});
