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

const mockCancelAnimation = jest.fn();

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { createAnimatedComponent: (c: unknown) => c },
  useSharedValue: (...args: unknown[]) => mockUseSharedValue(...args),
  // Non-empty so the animated <G> is distinguishable from the frozen frame,
  // which renders a plain `transform` string and no animatedProps.
  useAnimatedProps: () => ({ transform: [] }),
  withRepeat: jest.fn((v: unknown) => v),
  withTiming: jest.fn(),
  withSequence: jest.fn((...v: unknown[]) => v),
  cancelAnimation: (...args: unknown[]) => mockCancelAnimation(...args),
  Easing: { inOut: () => () => 0, ease: () => 0 },
}));

// Drives the focus/foreground gate. Default true so the pre-existing specs
// (which assert the animated path) keep describing the same behaviour.
let mockAnimationsActive = true;
jest.mock('@/lib/hooks/use-is-focused-safe', () => ({
  useAnimationsActive: () => mockAnimationsActive,
}));

import { render } from '@testing-library/react-native';
import React from 'react';
import MeraLogo from '../MeraLogo';

describe('MeraLogo', () => {
  beforeEach(() => {
    mockUseSharedValue.mockClear();
    mockCancelAnimation.mockClear();
    mockAnimationsActive = true;
  });

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

  // B1.5 — this animates an SVG <G transform>, which RNSVG rasterises on the
  // CPU every frame. AllCaughtUpCard puts one at the bottom of the Feed, and
  // tabs stay mounted, so an ungated loop re-rasterises forever off-screen.
  describe('focus/foreground gate', () => {
    const STATIC_TRANSFORM = 'rotate(-15 512 760)';

    it('animates while focused and foregrounded', () => {
      mockAnimationsActive = true;
      const { queryAllByTestId } = render(<MeraLogo size={56} animated />);
      const gs = queryAllByTestId('svg-G');
      // The animated node carries animatedProps; the frozen frame does not.
      expect(gs.some((g) => g.props.animatedProps !== undefined)).toBe(true);
      expect(gs.some((g) => g.props.transform === STATIC_TRANSFORM)).toBe(false);
    });

    it('falls back to the frozen frame when blurred or backgrounded', () => {
      mockAnimationsActive = false;
      const { queryAllByTestId } = render(<MeraLogo size={56} animated />);
      const gs = queryAllByTestId('svg-G');
      // Animated node gone entirely — cheaper than merely pausing it, and
      // visually identical to the static call path at rest.
      expect(gs.some((g) => g.props.animatedProps !== undefined)).toBe(false);
      expect(gs.some((g) => g.props.transform === STATIC_TRANSFORM)).toBe(true);
    });

    it('cancels the shared value so nothing keeps driving it on the UI thread', () => {
      mockAnimationsActive = false;
      render(<MeraLogo size={56} animated />);
      expect(mockCancelAnimation).toHaveBeenCalled();
    });
  });
});

// The `color` prop exists so the glyph can sit on a LIGHT ground (the article
// image placeholder is a near-white panel). Every other call site is chrome on
// the dark theme and relies on the white default, so the default is
// load-bearing — a regression there would turn a dozen action-bar icons
// invisible at once.
describe('MeraLogo color', () => {
  const inkOf = (utils: ReturnType<typeof render>) =>
    utils.getAllByTestId('svg-Circle')[0].props.fill; // the focus dot

  it('defaults to white for the dark-theme chrome call sites', () => {
    expect(inkOf(render(<MeraLogo size={24} />))).toBe('#fff');
  });

  it('threads an override through every stroke and fill', () => {
    const utils = render(<MeraLogo size={24} color="#2A2622" />);
    expect(inkOf(utils)).toBe('#2A2622');
    // hexagon outline + highlighted card + grid strokes all follow the same ink
    const strokes = [
      ...utils.getAllByTestId('svg-Path'),
      ...utils.getAllByTestId('svg-Rect'),
      ...utils.getAllByTestId('svg-G'),
    ]
      .map((n) => n.props.stroke)
      .filter(Boolean);
    expect(strokes.length).toBeGreaterThan(0);
    expect(strokes.every((c: string) => c === '#2A2622')).toBe(true);
  });

  it('colours the frozen spotlight too (static path)', () => {
    const utils = render(<MeraLogo size={24} color="#2A2622" />);
    const fills = utils.getAllByTestId('svg-Path').map((n) => n.props.fill).filter(Boolean);
    expect(fills).toContain('#2A2622');
  });
});

// Every existing caller renders byte-identically after `scrollCards` was added.
// The snapshot was recorded from the component BEFORE that prop existed; a
// diff here means a default render changed, which no caller asked for.
describe('MeraLogo default renders are unchanged', () => {
  beforeEach(() => {
    mockAnimationsActive = true;
  });
  it.each([
    ['static default', {}],
    ['static, sized and coloured', { size: 22, color: '#F87171' }],
    ['animated sweep', { size: 56, animated: true }],
  ] as const)('%s', (_name, props) => {
    const { toJSON } = render(<MeraLogo {...(props as any)} />);
    expect(toJSON()).toMatchSnapshot();
  });
});

// Owner: while the Feed processes, the torch sweeps (the `animated` sweep) and
// the background cards scroll right to left behind it, "Mera reading all the
// news". The cards are the 150x110 grid Rects inside the hexagon clip.
describe('MeraLogo scrollCards', () => {
  beforeEach(() => {
    mockUseSharedValue.mockClear();
    mockAnimationsActive = true;
  });
  const scroller = (r: ReturnType<typeof render>) =>
    r.UNSAFE_root.findAll((n: any) => n.props?.testID === 'mera-logo-cards' && typeof n.type === 'string');

  it('scrolls a five-column grid under an animated group, inside the hexagon clip', () => {
    const r = render(<MeraLogo size={22} scrollCards />);
    const groups = scroller(r);
    expect(groups).toHaveLength(1);
    expect(groups[0].props.animatedProps).toBeDefined();
    // 5 columns x 3 rows, so the wrap at one pitch is seamless.
    expect(groups[0].findAll((n: any) => n.props?.testID === 'svg-Rect' && typeof n.type === 'string')).toHaveLength(15);
    let clipped = false;
    for (let p: any = groups[0].parent; p; p = p.parent) if (p.props?.clipPath === 'url(#hexB)') clipped = true;
    expect(clipped).toBe(true);
    expect(mockUseSharedValue).toHaveBeenCalled();
  });

  it('keeps the highlighted card and the focus dot fixed, outside the scrolling group', () => {
    const r = render(<MeraLogo size={22} scrollCards />);
    const group = scroller(r)[0];
    const inGroup = (n: any) => {
      for (let p = n.parent; p; p = p.parent) if (p === group) return true;
      return false;
    };
    const highlighted = r.UNSAFE_root.findAll(
      (n: any) => n.props?.testID === 'svg-Rect' && n.props?.strokeWidth === '16' && typeof n.type === 'string',
    );
    expect(highlighted).toHaveLength(1);
    expect(inGroup(highlighted[0])).toBe(false);
  });

  it('falls back to the still three-column grid when nobody is looking', () => {
    mockAnimationsActive = false;
    const r = render(<MeraLogo size={22} scrollCards />);
    expect(scroller(r)).toHaveLength(0);
  });

  it('combines with the torch sweep', () => {
    const r = render(<MeraLogo size={22} animated scrollCards />);
    expect(scroller(r)).toHaveLength(1);
    const sweeping = r.UNSAFE_root.findAll(
      (n: any) => n.props?.testID === 'svg-G' && n.props?.animatedProps !== undefined && typeof n.type === 'string',
    );
    expect(sweeping).toHaveLength(1);
  });
});
