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

    // The ANDROID branch cannot be rendered here — `jest.setup.js` pins
    // `Platform.OS` to 'ios' globally — so its CSS string is asserted directly
    // instead. That matters more than it looks: `processBackgroundImage` fails
    // by `return []`, with no error and no warning, so a malformed value paints
    // NOTHING and is indistinguishable from the flat tint this branch replaced.
    // Feeding the real parser is the only check that can tell those apart.
    describe('android CSS gradient string', () => {
        const {
            sectionGradient,
            sectionColorAtAlpha,
        } = require('@/lib/section-color') as typeof import('@/lib/section-color');
        const spec = sectionGradient('fact-1');
        const value =
            `linear-gradient(to right, ` +
            `${sectionColorAtAlpha(spec.hue, spec.startOpacity)} 0%, ` +
            `${sectionColorAtAlpha(spec.hue, spec.endOpacity)} 100%)`;

        it('parses through React Native own background-image parser', () => {
            const processBackgroundImage =
                require('react-native/Libraries/StyleSheet/processBackgroundImage').default;
            const parsed = processBackgroundImage(value);
            expect(parsed).toHaveLength(1);
            expect(parsed[0].type).toBe('linear-gradient');
            expect(parsed[0].colorStops).toHaveLength(2);
        });

        it('bakes the opacity into the colour and never uses `transparent`', () => {
            // CSS has no `stopOpacity`. And `transparent` is `rgba(0,0,0,0)`, so
            // fading to it would drag the pastel through grey instead of just
            // vanishing.
            expect(value).toContain(`, ${spec.startOpacity})`);
            expect(value).toContain(`, ${spec.endOpacity})`);
            expect(value).not.toContain('transparent');
        });

        it('uses the SAME hue as `base`, so the two branches cannot drift', () => {
            expect(spec.base).toContain(`${spec.hue},`);
            expect(value).toContain(`hsla(${spec.hue},`);
        });
    });
});
