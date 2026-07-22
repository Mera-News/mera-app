// MeraLogo static-by-default tests. react-native-svg + reanimated are stubbed
// so the SVG renders as plain views and the reanimated hooks can be observed:
// the animated spotlight lives in a subcomponent that owns useSharedValue, so
// that hook firing is a clean proxy for "the animated node was rendered".
/* eslint-disable @typescript-eslint/no-require-imports */

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

const mockUseSharedValue = jest.fn((..._a: unknown[]) => ({ value: -15 }));

jest.mock('react-native-svg', () => {
  const { View } = require('react-native');
  const Svg = (props: any) => <View testID="svg-Svg" {...props} />;
  const Circle = (props: any) => <View testID="svg-Circle" {...props} />;
  const ClipPath = (props: any) => <View testID="svg-ClipPath" {...props} />;
  const G = (props: any) => <View testID="svg-G" {...props} />;
  const Path = (props: any) => <View testID="svg-Path" {...props} />;
  const Rect = (props: any) => <View testID="svg-Rect" {...props} />;
  return { __esModule: true, default: Svg, Svg, Circle, ClipPath, G, Path, Rect };
});

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { createAnimatedComponent: (c: unknown) => c },
  useSharedValue: (...args: unknown[]) => mockUseSharedValue(...args),
  useAnimatedProps: () => ({}),
  withRepeat: jest.fn(),
  withTiming: jest.fn(),
  withSequence: jest.fn(),
  Easing: { inOut: () => () => 0, ease: () => 0 },
}));

import { render } from '@testing-library/react-native';
import React from 'react';
import MeraLogo from '../MeraLogo';

describe('MeraLogo', () => {
  beforeEach(() => mockUseSharedValue.mockClear());

  it('renders static by default with no reanimated involvement', () => {
    const { getByTestId } = render(<MeraLogo size={24} />);
    expect(mockUseSharedValue).not.toHaveBeenCalled();
    // Tight glyph viewBox applies to every render.
    expect(getByTestId('svg-Svg').props.viewBox).toBe('255 146 514 732');
  });

  it('mounts the reanimated spotlight only when animated', () => {
    render(<MeraLogo size={56} animated />);
    expect(mockUseSharedValue).toHaveBeenCalled();
  });

  it('keeps the tight viewBox when animated', () => {
    const { getByTestId } = render(<MeraLogo size={56} animated />);
    expect(getByTestId('svg-Svg').props.viewBox).toBe('255 146 514 732');
  });
});
