/* eslint-disable @typescript-eslint/no-require-imports */
import { render } from '@testing-library/react-native';
import React from 'react';

// css-interop JSX shim (reads Platform.OS at module load; undefined under
// jest-expo) — same shim the other component tests use.
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

jest.mock('react-native-svg', () => {
    const { View } = require('react-native');
    const Passthrough = (props: any) => <View {...props} />;
    return {
        __esModule: true,
        default: (props: any) => <View testID="section-svg" {...props} />,
        Svg: (props: any) => <View testID="section-svg" {...props} />,
        Defs: Passthrough,
        LinearGradient: Passthrough,
        Stop: Passthrough,
        Rect: Passthrough,
    };
});

import { Text } from 'react-native';
import SectionGradientPanel from '../SectionGradientPanel';

describe('SectionGradientPanel', () => {
    it('renders its children', () => {
        const { getByText } = render(
            <SectionGradientPanel factId="fact-1">
                <Text>panel body</Text>
            </SectionGradientPanel>,
        );
        expect(getByText('panel body')).toBeTruthy();
    });

    it('draws the gradient svg beneath the children', () => {
        const { getByTestId } = render(
            <SectionGradientPanel factId="fact-1">
                <Text>panel body</Text>
            </SectionGradientPanel>,
        );
        expect(getByTestId('section-svg')).toBeTruthy();
    });
});
